import { storage } from "./storage";
import { getExpertResponse, getExpertResponseStream, generateInsights, getModeratorNextSpeakerSuggestion, generateClosingSynthesis, resolveAuxModel } from "./ai";
import type { ModeratorContext } from "./ai";
import { shouldStopForRedundancy, REDUNDANCY_STOP_SIMILARITY_THRESHOLD } from "./text-similarity";
import type { InsertMessage, Expert, Message, File, OrchestratorSnapshot } from "@shared/schema";
import { extractFarmerQuestions } from "@shared/mentions";

// Verbose per-turn tracing is opt-in (ORCH_DEBUG=1). The default flood slows
// test teardown and leaks conversation content into production logs.
const ORCH_DEBUG = process.env.ORCH_DEBUG === "1";
const debugLog = (...args: unknown[]) => {
    if (ORCH_DEBUG) console.log(...args);
};

// Define interaction modes more formally
type InteractionMode = 
    | "idle"          // Not processing anything
    | "processing_sequential" // Legacy snapshot mode; new discussions start autonomous
    | "paused"        // User manually paused
    | "autonomous";   // Experts interacting autonomously (Future Step)

interface ConversationState {
    conversationId: number;
    // Speakable, persisted experts only. The system Moderator has its own
    // context below and must never occupy a turn index or roster position.
    activeExperts: Expert[];
    moderatorExpert: ModeratorContext;
    currentExpertIndex: number;
    lastUserMessage: Message | null; // Store the user message that triggered the sequence
    mode: InteractionMode;
    broadcastFn: (convId: number, data: any) => void; // Store broadcast function
    // Autonomous settings
    isAutonomousEnabled: boolean; // Default: true
    maxAutonomousTurns: number;   // Max expert responses; 100 represents the hard-capped "let it run" option
    totalAutonomousTurnsTaken: number; // Counter for turns within the current autonomous session
    // Add a flag to indicate if the current sequence was interrupted by the user
    wasInterrupted: boolean;
    // The newest ordinary farmer message waiting to be incorporated by the
    // next speaker. All messages remain in storage history; this pointer is
    // only the current prompt/routing handoff.
    pendingUserMessage: Message | null;
    // FIFO of all valid @-routed speaker requests since the current routing
    // point, preserving source text order across farmer and expert messages.
    pendingMentionRoutes: PendingMentionRoute[];
    // True until the system Moderator has made its next-speaker decision
    // after a farmer message arrived.
    farmerJustSpoke: boolean;
    // Idle conversations with autonomy disabled still get one routed expert
    // response, then end naturally.
    singleTurnOnly: boolean;
    // Preserve the active phase while a sequence is paused.
    pausedFromMode: Exclude<InteractionMode, "idle" | "paused"> | null;
    // Internal (never broadcast): a turn is actively streaming right now.
    // pause() can land mid-turn; this is the only reliable "is a turn
    // actually streaming" signal for in-place resume.
    turnInFlight: boolean;
    // Internal (never broadcast): a processNextTurn chain is scheduled but
    // has not fired yet. Exactly one chain may drive a conversation at a
    // time — pause() followed immediately by resume() can otherwise leave
    // two setImmediate chains pending (one from the loop's own next-turn
    // scheduling, one from resume), double-driving turns and insights.
    turnChainScheduled: boolean;
    // Internal (never broadcast): one chain currently owns routing/turn
    // awaits. A paused join resumes this chain in place instead of scheduling
    // a competing chain while the Moderator is still deciding.
    turnChainRunning: boolean;
    // Consecutive scheduled processing failures for this in-memory session.
    // Successful expert persistence or explicit /new resets the counter.
    scheduledFailureAttempts: number;
    // In-memory recovery guard for a loop that died between turns.
    lastProgressAt: number;
    // Expert message contents of the CURRENT sequence (sequential round 1 +
    // autonomous extension). Used by the F2 redundancy early-stop; reset when
    // a new sequence starts, carried across the sequential→autonomous
    // transition.
    sequenceExpertContents: string[];
    // Legacy G4 snapshot field. New G11 sequences route mentions through the
    // pending FIFO and leave this list empty; Moderator is never in it.
    roundExperts: Expert[];
    // G4 ping-pong guard: the unordered role pair ("A<B", sorted) of the last
    // mention-routed turn plus how many consecutive mention-routed turns that
    // pair has logged. null whenever the previous turn was not mention-routed.
    mentionPairStreak: { key: string; count: number } | null;
    // G8 aux hygiene: the "Moderator unavailable — speaking in round-robin."
    // notice is broadcast at most ONCE PER SEQUENCE. Set when the notice goes
    // out; reset when a new sequence starts (startProcessingSequence /
    // initializeConversationState). In-memory only — never part of the G7
    // snapshot.
    moderatorNoticeSent: boolean;
    // We might add turn limits, autonomous rounds etc. later
}

interface PendingMentionRoute {
    role: string;
    // Null for farmer mentions; expert-origin routes retain the speaker role
    // for the existing same-pair ping-pong guard.
    sourceRole: string | null;
}

// Placeholder - In-memory state management
const conversationStates: Map<number, ConversationState> = new Map();
const STALE_PROCESSING_MS = 5 * 60 * 1000;
const DEFAULT_TURN_BUDGET = 25;
const MAX_TURN_BUDGET = 100;

// ─── G7: Survivable orchestrator state ───────────────────────────────────────
// A minimal snapshot is persisted to the conversation row at TURN BOUNDARIES
// ONLY (never per token, never on turnInFlight/turnChainScheduled flips) so a
// server restart mid-round can reconstruct honest state: dead loops
// (processing_sequential/autonomous) recover to idle; paused restores paused.

function buildSnapshot(state: ConversationState): OrchestratorSnapshot {
    return {
        mode: state.mode,
        currentExpertIndex: state.currentExpertIndex,
        totalAutonomousTurnsTaken: state.totalAutonomousTurnsTaken,
        wasInterrupted: state.wasInterrupted,
        pausedFromMode: state.pausedFromMode,
        // Optional in the JSONB type for backwards compatibility with G7/G11
        // rows written before G13.
        isAutonomousEnabled: state.isAutonomousEnabled,
        maxAutonomousTurns: state.maxAutonomousTurns,
    };
}

function snapshotsDiffer(a: OrchestratorSnapshot, b: OrchestratorSnapshot): boolean {
    return a.mode !== b.mode ||
        a.currentExpertIndex !== b.currentExpertIndex ||
        a.totalAutonomousTurnsTaken !== b.totalAutonomousTurnsTaken ||
        a.wasInterrupted !== b.wasInterrupted ||
        a.pausedFromMode !== b.pausedFromMode ||
        a.isAutonomousEnabled !== b.isAutonomousEnabled ||
        a.maxAutonomousTurns !== b.maxAutonomousTurns;
}

/** Convert the persisted user choice into a runtime limit with a hard ceiling. */
function effectiveTurnBudget(configuredBudget: number | null | undefined): number {
    // Undefined is a legacy/missing field and gets the established default.
    if (configuredBudget === undefined) return DEFAULT_TURN_BUDGET;
    // Null and 0 both mean “let it run”; the safety ceiling still applies.
    if (configuredBudget === null || configuredBudget === 0) return MAX_TURN_BUDGET;
    if (!Number.isInteger(configuredBudget) || configuredBudget < 1) return DEFAULT_TURN_BUDGET;
    return Math.min(configuredBudget, MAX_TURN_BUDGET);
}

function snapshotBooleanOrDefault(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function snapshotBudgetOrFallback(snapshotValue: unknown, configuredBudget: number | null | undefined): number {
    return typeof snapshotValue === "number" && Number.isInteger(snapshotValue) && snapshotValue >= 1
        ? Math.min(snapshotValue, MAX_TURN_BUDGET)
        : effectiveTurnBudget(configuredBudget);
}

// One serialized write chain per conversation: updateConversationState must
// stay synchronous, so the write is fired WITHOUT awaiting and chained on the
// previous write to preserve turn-boundary order. The chain stores a
// rejection-proof predecessor (the .catch(() => {}) below): a failed write is
// logged once by its own .catch, and later writes still reach storage — one
// storage failure never poisons the chain for the conversation's lifetime.
const snapshotWriteChains: Map<number, Promise<void>> = new Map();

function persistSnapshot(conversationId: number, snapshot: OrchestratorSnapshot): void {
    // Partial test doubles may omit updateConversation; the IStorage contract
    // guarantees it in production, so absence is a silent skip, not an error.
    if (typeof storage.updateConversation !== "function") {
        debugLog(`Orchestrator: storage.updateConversation unavailable — snapshot for ${conversationId} not persisted.`);
        return;
    }
    try {
        const previous = snapshotWriteChains.get(conversationId) ?? Promise.resolve();
        const write = previous
            .catch(() => {})
            .then(() => storage.updateConversation(conversationId, { orchestratorState: snapshot }))
            .then(() => undefined);
        snapshotWriteChains.set(conversationId, write);
        write.catch((error) => {
            console.error(`Orchestrator: Failed to persist orchestrator snapshot for conversation ${conversationId}:`, error);
        });
    } catch (error) {
        // Synchronous enqueue failure — same contract: never break the loop.
        console.error(`Orchestrator: Failed to enqueue orchestrator snapshot for conversation ${conversationId}:`, error);
    }
}

export function isUsableConversationState(state: ConversationState | undefined): state is ConversationState {
    return Boolean(
        state &&
        typeof state.broadcastFn === "function" &&
        Array.isArray(state.activeExperts) &&
        state.activeExperts.length > 0 &&
        state.activeExperts.every(e => isSpeakableExpertRole(e.role)) &&
        state.moderatorExpert &&
        state.moderatorExpert.conversationId === state.conversationId &&
        state.moderatorExpert.role === "Moderator" &&
        (state.moderatorExpert.id === null || Number.isInteger(state.moderatorExpert.id)) &&
        typeof state.moderatorExpert.name === "string" &&
        (state.moderatorExpert.model === null || typeof state.moderatorExpert.model === "string") &&
        typeof state.moderatorExpert.systemPrompt === "string" &&
        typeof state.isAutonomousEnabled === "boolean" &&
        Number.isInteger(state.maxAutonomousTurns) &&
        state.maxAutonomousTurns >= 1 && state.maxAutonomousTurns <= MAX_TURN_BUDGET &&
        (state.pendingUserMessage === null || (typeof state.pendingUserMessage === "object" && state.pendingUserMessage.role === "user")) &&
        Array.isArray(state.pendingMentionRoutes) &&
        state.pendingMentionRoutes.every(route =>
            route && typeof route.role === "string" &&
            (route.sourceRole === null || typeof route.sourceRole === "string")
        ) &&
        typeof state.farmerJustSpoke === "boolean" &&
        typeof state.singleTurnOnly === "boolean" &&
        Number.isInteger(state.currentExpertIndex) &&
        ["idle", "processing_sequential", "paused", "autonomous"].includes(state.mode) &&
        typeof state.lastProgressAt === "number" &&
        typeof state.turnChainRunning === "boolean" &&
        Number.isInteger(state.scheduledFailureAttempts) && state.scheduledFailureAttempts >= 0 &&
        Array.isArray(state.sequenceExpertContents) &&
        Array.isArray(state.roundExperts) &&
        state.roundExperts.every(e => isSpeakableExpertRole(e.role)) &&
        // G8/G10: fields initializeConversationState always sets must be asserted
        // here (established invariant) — a partial/stale state object missing
        // one is re-initialized instead of limping through the sequence.
        typeof state.moderatorNoticeSent === "boolean"
    );
}

function isSpeakableExpertRole(role: string): boolean {
    return role !== "Moderator" && role !== "User" && role !== "Farmer";
}

// Legacy G4 helper retained for compatibility with older sequential code.
// G11 routes recognized mentions one at a time through pendingMentionRoutes.
function selectRoundExperts(activeExperts: Expert[], mentions?: string[] | null): Expert[] {
    // Be defensive at the round boundary too: the Moderator is a chair, not
    // an expert that a user mention can wake into the speaking round.
    const speakableExperts = activeExperts.filter(e => isSpeakableExpertRole(e.role));
    if (!mentions || mentions.length === 0) return speakableExperts;
    const expertByRole = new Map(speakableExperts.map(expert => [expert.role, expert]));
    const narrowed: Expert[] = [];
    const seen = new Set<string>();
    for (const role of mentions) {
        if (!isSpeakableExpertRole(role)) continue;
        const expert = expertByRole.get(role);
        if (expert && !seen.has(role)) {
            narrowed.push(expert);
            seen.add(role);
        }
    }
    return narrowed.length > 0 ? narrowed : speakableExperts;
}

function mentionRoutesForMessage(
    mentions: string[] | null | undefined,
    sourceRole: string | null,
    activeExperts: Expert[]
): PendingMentionRoute[] {
    if (!Array.isArray(mentions) || mentions.length === 0) return [];
    const speakableRoles = new Set(activeExperts.map(expert => expert.role));
    return Array.from(new Set(mentions))
        .filter(role => isSpeakableExpertRole(role) && speakableRoles.has(role))
        .map(role => ({ role, sourceRole }));
}

function restoredPausedFromMode(mode: unknown): ConversationState["pausedFromMode"] {
    // A paused snapshot from the previous process does not preserve the live
    // sequential chain; resume it through autonomous continuation. A snapshot
    // already parked in autonomous remains there.
    if (mode === "processing_sequential" || mode === "autonomous") return "autonomous";
    return null;
}

/**
 * Split the persisted roster into ordinary speakers and the separate system
 * chair context. A configured Moderator row supplies chair identity/model
 * settings but never enters the speaker collection. Without one, create an
 * in-memory chair context; it is never inserted into storage.
 */
function partitionExpertRoster(conversationId: number, roster: Expert[]): {
    activeExperts: Expert[];
    moderatorExpert: ModeratorContext;
} {
    const activeExperts = roster.filter(expert => isSpeakableExpertRole(expert.role));
    const configuredModerator = roster.find(expert => expert.role === "Moderator");
    const moderatorExpert: ModeratorContext = configuredModerator
        ? {
            id: configuredModerator.id,
            conversationId,
            name: configuredModerator.name,
            role: "Moderator",
            model: configuredModerator.model,
            systemPrompt: configuredModerator.systemPrompt,
        }
        : {
            id: null,
            conversationId,
            name: "Moderator",
            role: "Moderator",
            model: resolveAuxModel(null, activeExperts[0]?.model ?? null),
            systemPrompt: "You are the system Moderator, chairing the agricultural roundtable and routing discussion among its experts.",
        };
    return { activeExperts, moderatorExpert };
}

// History scans must never mistake a stored failure for a real expert
// contribution. Orchestrator-stored provider errors start with "(Error
// getting response from", cached/legacy error rows start with "(Error
// generating response", and vision rejections start with "⚠️" — all three
// families are excluded from "last real expert message" lookups.
function isRealExpertHistoryMessage(m: Message): boolean {
    return m.role === "assistant" &&
        !m.content.startsWith("(Error") &&
        !m.content.startsWith("⚠️");
}

// Export this helper function
export function getConversationState(conversationId: number): ConversationState | undefined {
    return conversationStates.get(conversationId);
}

// Updated state update function to broadcast mode changes and autonomous status
function updateConversationState(
    conversationId: number, 
    updates: Partial<Omit<ConversationState, 'conversationId' | 'broadcastFn'>> 
): ConversationState {
    const existingState = conversationStates.get(conversationId);
    if (!existingState) {
        throw new Error(`State for conversation ${conversationId} not found during update.`);
    }

    const previousState = { ...existingState }; // Shallow copy for comparison
    const newState = { ...existingState, ...updates, lastProgressAt: Date.now() };
    conversationStates.set(conversationId, newState);

    // G7: persist the snapshot at this turn boundary — but ONLY when one of
    // the persisted fields actually changed. No-op updates, lastProgressAt
    // ticks, internal-only flips (turnInFlight/turnChainScheduled) and
    // in-memory-only changes (sequenceExpertContents/mentionPairStreak/
    // roundExperts/moderatorExpert) never write.
    const previousSnapshot = buildSnapshot(previousState);
    const nextSnapshot = buildSnapshot(newState);
    if (snapshotsDiffer(previousSnapshot, nextSnapshot)) {
        persistSnapshot(conversationId, nextSnapshot);
    }

    debugLog(`State updated for ${conversationId}: mode=${newState.mode}, expertIndex=${newState.currentExpertIndex}, autoTurns=${newState.totalAutonomousTurnsTaken}/${newState.maxAutonomousTurns}, interrupted=${newState.wasInterrupted}`);

    // Broadcast relevant state changes
    if (newState.mode !== previousState.mode ||
        newState.isAutonomousEnabled !== previousState.isAutonomousEnabled ||
        newState.maxAutonomousTurns !== previousState.maxAutonomousTurns) {
        existingState.broadcastFn(conversationId, { 
            type: "state_update", 
            mode: newState.mode, 
            isAutonomousEnabled: newState.isAutonomousEnabled,
            maxAutonomousTurns: newState.maxAutonomousTurns
        });
        debugLog(`Broadcasted state update for ${conversationId}: mode=${newState.mode}, autoEnabled=${newState.isAutonomousEnabled}`);
    }

    return newState;
}

// Initialize state when orchestrator is first needed for a conversation
function initializeConversationState(conversationId: number, activeExperts: Expert[], moderatorExpert: ModeratorContext, userMessage: Message, broadcastFn: (convId: number, data: any) => void, maxAutonomousTurns = DEFAULT_TURN_BUDGET): ConversationState {
    const initialState: ConversationState = {
        conversationId,
        activeExperts,
        moderatorExpert,
        currentExpertIndex: -1, 
        lastUserMessage: userMessage,
        mode: "idle", 
        broadcastFn: broadcastFn,
        // Initialize autonomous settings
        isAutonomousEnabled: true, // Autonomous is ON by default
        maxAutonomousTurns: effectiveTurnBudget(maxAutonomousTurns),
        totalAutonomousTurnsTaken: 0,
        wasInterrupted: false, // Initialize interrupted flag
        pendingUserMessage: null,
        pendingMentionRoutes: [],
        farmerJustSpoke: true,
        singleTurnOnly: false,
        pausedFromMode: null,
        turnInFlight: false,
        turnChainScheduled: false,
        turnChainRunning: false,
        scheduledFailureAttempts: 0,
        lastProgressAt: Date.now(),
        sequenceExpertContents: [],
        roundExperts: selectRoundExperts(activeExperts, userMessage.mentions),
        mentionPairStreak: null,
        moderatorNoticeSent: false
    };
    conversationStates.set(conversationId, initialState);
    debugLog(`Initialized state for ${conversationId}, Auto ON (max ${initialState.maxAutonomousTurns} turns)`);
    // G7: the fresh idle state is this server's recovery truth for the
    // conversation — persist it immediately so a snapshot left by a previous
    // process (paused, or a dead processing loop) is corrected the moment we
    // take over. Every cold start goes through here.
    persistSnapshot(conversationId, buildSnapshot(initialState));
    // Broadcast initial state including autonomous info
    broadcastFn(conversationId, {
        type: "state_update",
        mode: "idle",
        isAutonomousEnabled: initialState.isAutonomousEnabled,
        maxAutonomousTurns: initialState.maxAutonomousTurns
    });
    return initialState;
}

// G7 follow-up: rebuild a live paused state from the row's persisted snapshot
// so POST /resume works after a server restart (the snapshot says paused but
// no in-memory state exists — the old process took the paused turn chain with
// it). Returns true when the paused state was restored; false when a live
// state already exists or the snapshot is missing / anything-but-paused (the
// caller keeps its existing 404 behavior in that case). Nothing is scheduled
// here — the caller's resume() claims turnChainScheduled itself.
export async function restorePausedFromSnapshot(
    conversationId: number,
    broadcastFn: (convId: number, data: any) => void
): Promise<boolean> {
    if (getConversationState(conversationId)) return false;
    if (typeof storage.getConversation !== "function" || typeof storage.getConversationExperts !== "function") return false;

    let storedSnapshot: OrchestratorSnapshot | null = null;
    let configuredBudget: number | null | undefined;
    try {
        const conversationRow = await storage.getConversation(conversationId);
        storedSnapshot = conversationRow?.orchestratorState ?? null;
        configuredBudget = conversationRow?.turnBudget;
    } catch (error) {
        console.error(`Orchestrator: Could not read stored orchestrator snapshot for conversation ${conversationId}:`, error);
        return false;
    }
    if (!storedSnapshot || storedSnapshot.mode !== "paused") return false;

    const experts = await storage.getConversationExperts(conversationId);
    if (!experts || experts.length === 0) {
        debugLog(`Orchestrator: no experts for conversation ${conversationId} — cannot restore the paused state.`);
        return false;
    }
    const { activeExperts, moderatorExpert } = partitionExpertRoster(conversationId, experts);
    if (activeExperts.length === 0) {
        debugLog(`Orchestrator: no speakable experts for conversation ${conversationId} — cannot restore the paused state.`);
        return false;
    }

    // Fresh in-memory state, then restore the pause through the shared update
    // path so the paused state_update broadcast and persisted snapshot
    // (carrying the restored index/counters) behave like the cold-start path.
    // lastUserMessage stays null until a new farmer message joins the parked
    // sequence in place.
    const restored: ConversationState = {
        conversationId,
        activeExperts,
        moderatorExpert,
        currentExpertIndex: Number.isInteger(storedSnapshot.currentExpertIndex)
            ? storedSnapshot.currentExpertIndex
            : -1,
        lastUserMessage: null,
        mode: "idle",
        broadcastFn,
        isAutonomousEnabled: snapshotBooleanOrDefault(storedSnapshot.isAutonomousEnabled, true),
        maxAutonomousTurns: snapshotBudgetOrFallback(storedSnapshot.maxAutonomousTurns, configuredBudget),
        totalAutonomousTurnsTaken: Number.isInteger(storedSnapshot.totalAutonomousTurnsTaken)
            ? storedSnapshot.totalAutonomousTurnsTaken
            : 0,
        wasInterrupted: false,
        pendingUserMessage: null,
        pendingMentionRoutes: [],
        farmerJustSpoke: false,
        singleTurnOnly: false,
        pausedFromMode: null,
        turnInFlight: false,
        turnChainScheduled: false,
        turnChainRunning: false,
        scheduledFailureAttempts: 0,
        lastProgressAt: Date.now(),
        sequenceExpertContents: [],
        roundExperts: activeExperts,
        mentionPairStreak: null,
        moderatorNoticeSent: false,
    };
    conversationStates.set(conversationId, restored);
    updateConversationState(conversationId, {
        mode: "paused",
        pausedFromMode: restoredPausedFromMode(storedSnapshot.pausedFromMode)
    });
    debugLog(`Orchestrator: restored paused state for ${conversationId} from snapshot (from ${storedSnapshot.pausedFromMode ?? "unknown"}, index ${restored.currentExpertIndex}).`);
    return true;
}

function scheduleInterruptedMessage(state: ConversationState, pendingMessage: Message, restart = false): void {
    const userId = pendingMessage.userId ?? 0;
    setImmediate(() => {
        processMessageTurnBased(userId, state.conversationId, pendingMessage, state.broadcastFn, { restart })
            .catch(error => {
                console.error(`Orchestrator: Failed to resume interrupted message for ${state.conversationId}:`, error);
                new InteractionOrchestrator(state.conversationId).handleScheduledFailure(error);
                state.broadcastFn(state.conversationId, {
                    type: "error",
                    message: "Failed to resume the interrupted message."
                });
            });
    });
}

// This class now manages the stateful turn-based flow
export class InteractionOrchestrator {
    private conversationId: number;

    constructor(conversationId: number) {
        this.conversationId = conversationId;
        // State initialization is now handled in processMessageTurnBased
    }

    // Renamed from handleUserMessage
    // Kicks off the sequence starting with the first expert
    async startProcessingSequence(): Promise<void> {
        const state = getConversationState(this.conversationId);
        // Allow starting only if idle
        if (!state || state.mode !== "idle") { 
            console.warn(`Orchestrator startProcessingSequence called for ${this.conversationId} but state is not idle (${state?.mode}). Aborting.`);
            return;
        }
        
        const singleTurnOnly = !state.isAutonomousEnabled;
        updateConversationState(this.conversationId, {
            // A farmer message starts with the same Moderator/mention routing
            // used by the autonomous loop. With autonomy disabled this is a
            // single routed response; enabled conversations continue under
            // the existing autonomous turn budget.
            mode: "autonomous",
            currentExpertIndex: -1,
            totalAutonomousTurnsTaken: 0,
            wasInterrupted: false, // Reset interrupted flag
            pausedFromMode: null,
            sequenceExpertContents: [], // New sequence: redundancy history starts empty
            // New discussions use the pending mention FIFO; roundExperts is
            // kept empty so routing never turns a mention into a forced roll
            // call.
            roundExperts: [],
            pendingMentionRoutes: mentionRoutesForMessage(state.lastUserMessage?.mentions, null, state.activeExperts),
            pendingUserMessage: state.lastUserMessage,
            farmerJustSpoke: true,
            singleTurnOnly,
            mentionPairStreak: null, // New sequence: mention pair streak starts fresh
            moderatorNoticeSent: false // New sequence: the G8 degradation notice may fire once more
        });

        debugLog(`Orchestrator starting processing sequence for conv ${this.conversationId}`);
        // Mark that exactly one turn chain is scheduled for this conversation.
        updateConversationState(this.conversationId, { turnChainScheduled: true });
        // Use setImmediate to avoid blocking the initial request and handle potential immediate pause
        setImmediate(() => {
            this.processNextTurn().catch(err => {
                this.handleScheduledFailure(err);
            });
        });
    }

    /** Recover queued farmer input after a turn chain or scheduled callback fails. */
    handleScheduledFailure(error: unknown): void {
        console.error(`Orchestrator: Turn chain failed for ${this.conversationId}:`, error);
        const existingState = getConversationState(this.conversationId);
        if (!existingState) return;
        const state = updateConversationState(this.conversationId, {
            scheduledFailureAttempts: existingState.scheduledFailureAttempts + 1,
            turnInFlight: false
        });

        if (state.scheduledFailureAttempts >= 3) {
            updateConversationState(this.conversationId, {
                mode: "idle",
                wasInterrupted: false,
                pausedFromMode: null,
                turnInFlight: false,
                turnChainScheduled: false
            });
            state.broadcastFn(this.conversationId, {
                type: "notice",
                conversationId: this.conversationId,
                message: "The council could not continue after three consecutive errors. Your message is saved; send another message when you’re ready to retry."
            });
            return;
        }

        const explicitRestart = state.wasInterrupted;
        const pendingMessage = explicitRestart ? state.lastUserMessage : state.pendingUserMessage;
        const hasPendingMentionRoutes = state.pendingMentionRoutes.length > 0;
        const canResumePendingInput = explicitRestart
            ? pendingMessage !== null
            : Boolean(pendingMessage || hasPendingMentionRoutes) &&
                state.mode !== "paused" &&
                state.totalAutonomousTurnsTaken < state.maxAutonomousTurns;

        if (canResumePendingInput) {
            // A restart is the only path allowed to discard the previous
            // sequence and reset its counters. Ordinary joins retain their
            // budget, routing queue, and sequence history through recovery.
            updateConversationState(this.conversationId, explicitRestart && pendingMessage ? {
                mode: "autonomous",
                currentExpertIndex: -1,
                totalAutonomousTurnsTaken: 0,
                wasInterrupted: false,
                pausedFromMode: null,
                pendingUserMessage: pendingMessage,
                pendingMentionRoutes: mentionRoutesForMessage(pendingMessage.mentions, null, state.activeExperts),
                farmerJustSpoke: true,
                singleTurnOnly: !state.isAutonomousEnabled,
                sequenceExpertContents: [],
                roundExperts: [],
                mentionPairStreak: null,
                moderatorNoticeSent: false,
                turnInFlight: false,
                turnChainScheduled: true
            } : {
                mode: "autonomous",
                wasInterrupted: false,
                pausedFromMode: null,
                turnInFlight: false,
                // A failed one-turn-only attempt did not answer the queued
                // input; allow the replacement routed response to run once.
                ...(state.singleTurnOnly ? { currentExpertIndex: -1 } : {}),
                turnChainScheduled: true
            });

            // Claim the scheduled slot before yielding. The current chain's
            // finally releases turnChainRunning before this callback fires.
            setImmediate(() => {
                this.processNextTurn().catch(nextError => this.handleScheduledFailure(nextError));
            });
            return;
        }

        // Keep paused joins parked for resume(). At the hard cap the message
        // remains in history/state, but the conversation stops without
        // claiming another expert turn.
        updateConversationState(this.conversationId, {
            mode: state.mode === "paused" ? "paused" : "idle",
            turnInFlight: false,
            turnChainScheduled: false,
            wasInterrupted: false,
            ...(!pendingMessage ? {
                currentExpertIndex: -1,
                totalAutonomousTurnsTaken: 0,
                pausedFromMode: null
            } : {})
        });
    }

    // Processes a single turn and triggers the next one if applicable
    private async processNextTurn(): Promise<void> {
        const scheduledState = getConversationState(this.conversationId);
        if (scheduledState?.turnChainRunning) {
            debugLog(`Orchestrator: another turn chain owns ${this.conversationId}; duplicate chain bowing out.`);
            return;
        }
        // Single-chain guard: claim the scheduled slot. Any second pending
        // chain (a stale chain from before an interrupted restart, ...) bows
        // out instead of double-driving the loop.
        if (!scheduledState?.turnChainScheduled) {
            debugLog(`Orchestrator: duplicate turn chain for ${this.conversationId} bowing out.`);
            return;
        }
        updateConversationState(this.conversationId, { turnChainScheduled: false, turnChainRunning: true });

        try {
        let state = getConversationState(this.conversationId);
        // A turn may still be streaming if a legacy scheduled chain reaches
        // this point. The owning chain continues from its own next-action step.
        if (state?.turnInFlight) {
            debugLog(`Orchestrator: turn still in flight for ${this.conversationId} — chain bowing out.`);
            return;
        }
        // Initial checks for stopping conditions
        if (!state || state.mode === "paused" || state.wasInterrupted) {
            const reason = !state ? "state missing" : state.mode === "paused" ? "paused" : "interrupted";
            debugLog(`Orchestrator stopping for ${this.conversationId}. Reason: ${reason}.`);
             if (state && state.wasInterrupted) {
                 // Only an explicit restart sets wasInterrupted. Discard any
                 // joined context and restart from the explicit topic.
                 const pendingMessage = state.lastUserMessage;
                 updateConversationState(this.conversationId, {
                     mode: "idle",
                     wasInterrupted: false,
                     currentExpertIndex: -1,
                     totalAutonomousTurnsTaken: 0,
                     pausedFromMode: null,
                     pendingMentionRoutes: [],
                     pendingUserMessage: pendingMessage,
                     farmerJustSpoke: true,
                     singleTurnOnly: false,
                     lastUserMessage: pendingMessage
                 });
                 if (pendingMessage) {
                     scheduleInterruptedMessage(state, pendingMessage, true);
                 }
             }
            return; 
        }
        if (state.mode !== "processing_sequential" && state.mode !== "autonomous") {
            debugLog(`Orchestrator stopping for ${this.conversationId}. Unexpected Mode: ${state.mode}`);
            return;
        }

        // G2 follow-up: autonomous was disabled while no turn was streaming
        // (e.g. disabled while paused-from-autonomous, then resumed; or
        // disabled between two scheduled turns). The contract is "the
        // sequence ends naturally once the current expert finishes" — with
        // no expert streaming, end immediately instead of billing one more
        // turn the user explicitly turned off.
        if (state.mode === "autonomous" && !state.isAutonomousEnabled && !state.singleTurnOnly && state.pendingUserMessage) {
            if (state.totalAutonomousTurnsTaken < state.maxAutonomousTurns) {
                state = updateConversationState(this.conversationId, { singleTurnOnly: true });
            } else {
                state = updateConversationState(this.conversationId, { pendingUserMessage: null, pendingMentionRoutes: [] });
            }
        }
        if (state.mode === "autonomous" && !state.isAutonomousEnabled &&
            (!state.singleTurnOnly || (state.currentExpertIndex >= 0 && !state.pendingUserMessage))) {
            debugLog(`Orchestrator: autonomous disabled before turn start for ${this.conversationId} — ending sequence naturally.`);
            updateConversationState(this.conversationId, {
                mode: "idle",
                currentExpertIndex: -1,
                totalAutonomousTurnsTaken: 0,
                pausedFromMode: null,
                singleTurnOnly: false,
                pendingUserMessage: null,
                pendingMentionRoutes: [],
                farmerJustSpoke: false
            });
            generateInsights(this.conversationId, state.broadcastFn).catch(console.error);
            return;
        }

        // 1. Determine the next expert index
        let nextExpertIndex = -1;
        // Set when the just-completed autonomous turn was redundant (F2) and
        // the sequence must stop early instead of scheduling another turn.
        let redundancyStopDetected = false;
        // G5: set when the Moderator answered 'Conclude' and the closing
        // synthesis turn has already been streamed inline below. The sequence
        // then ends through the natural-end cleanup. The synthesis is not a
        // normal turn: it never increments totalAutonomousTurnsTaken and
        // never touches currentExpertIndex. It DOES hold the turnInFlight
        // guard while it streams (see below) so pause/resume treat it as a
        // real in-flight turn.
        let concludeSynthesisDelivered = false;
        let selectedMentionRoute: PendingMentionRoute | null = null;
        // These are speakable expert roles only. The system Moderator advises
        // routing but is never a role the chair can select as a speaker.
        const availableRoles = state.activeExperts.map(e => e.role);

        if (state.mode === "autonomous") {
            const moderator = state.moderatorExpert;
            let suggestedRole: string | null = null;

            // A join during the Moderator await invalidates that verdict. Keep
            // the single chain and ask again with the latest persisted history.
            while (nextExpertIndex === -1) {
                state = getConversationState(this.conversationId)!;
                if (!state || state.wasInterrupted) {
                    if (state?.wasInterrupted) {
                        const pendingMessage = state.lastUserMessage;
                        updateConversationState(this.conversationId, {
                            mode: "idle", wasInterrupted: false, currentExpertIndex: -1,
                            totalAutonomousTurnsTaken: 0, pausedFromMode: null,
                            pendingMentionRoutes: [], pendingUserMessage: pendingMessage,
                            farmerJustSpoke: true, singleTurnOnly: false, lastUserMessage: pendingMessage
                        });
                        if (pendingMessage) scheduleInterruptedMessage(state, pendingMessage, true);
                    }
                    return;
                }
                if (state.mode === "paused" || state.turnChainScheduled) return;
                const farmerRoutingPending = Boolean(state.pendingUserMessage || state.farmerJustSpoke);
                const deferredExpertRoutes = farmerRoutingPending
                    ? state.pendingMentionRoutes.filter(route => route.sourceRole !== null)
                    : [];
                // User mentions outrank the Moderator pick; expert-origin
                // mentions wait until the Moderator has considered the latest
                // farmer input.
                const mentionQueue = farmerRoutingPending
                    ? state.pendingMentionRoutes.filter(route => route.sourceRole === null)
                    : state.pendingMentionRoutes.slice();
                let selectedRoute: PendingMentionRoute | undefined;
                while (mentionQueue.length && !selectedRoute) {
                    const candidate = mentionQueue.shift()!;
                    const candidateIndex = state.activeExperts.findIndex(expert => expert.role === candidate.role);
                    if (candidateIndex < 0 || candidate.role === candidate.sourceRole) continue;
                    if (candidate.sourceRole) {
                        const pairKey = [candidate.sourceRole, candidate.role].sort().join("<");
                        const streak = state.mentionPairStreak;
                        if (streak && streak.key === pairKey && streak.count >= 2) {
                            debugLog(`Orchestrator: mention ping-pong guard tripped for ${this.conversationId} (${pairKey}); deferring to Moderator.`);
                            continue;
                        }
                        updateConversationState(this.conversationId, {
                            pendingMentionRoutes: [...mentionQueue, ...deferredExpertRoutes],
                            mentionPairStreak: streak && streak.key === pairKey
                                ? { key: pairKey, count: streak.count + 1 }
                                : { key: pairKey, count: 1 }
                        });
                    } else {
                        updateConversationState(this.conversationId, {
                            pendingMentionRoutes: [...mentionQueue, ...deferredExpertRoutes],
                            mentionPairStreak: null
                        });
                    }
                    nextExpertIndex = candidateIndex;
                    selectedRoute = candidate;
                }
                // Persist skipped invalid/self/ping-pong entries too. Otherwise
                // an all-skipped queue would look perpetually fresh and loop.
                const currentQueue = getConversationState(this.conversationId)?.pendingMentionRoutes ?? [];
                const remainingRoutes = [...mentionQueue, ...deferredExpertRoutes];
                if (remainingRoutes.length !== currentQueue.length || remainingRoutes.some((route, index) =>
                    route.role !== currentQueue[index]?.role || route.sourceRole !== currentQueue[index]?.sourceRole
                )) {
                    updateConversationState(this.conversationId, { pendingMentionRoutes: remainingRoutes });
                }
                if (selectedRoute) {
                    selectedMentionRoute = selectedRoute;
                    break;
                }

                if (state.mentionPairStreak) updateConversationState(this.conversationId, { mentionPairStreak: null });
                const routingMessage = state.lastUserMessage;
                const farmerJustSpoke = state.farmerJustSpoke;
                let history = await storage.getConversationMessages(this.conversationId);
                let latestState = getConversationState(this.conversationId)!;
                if (latestState.wasInterrupted) continue;
                if (latestState.mode === "paused" || latestState.turnChainScheduled) return;
                if (latestState.pendingMentionRoutes.some(route => route.sourceRole === null) ||
                    (latestState.lastUserMessage !== routingMessage && latestState.farmerJustSpoke)) continue;

                suggestedRole = await getModeratorNextSpeakerSuggestion(
                    moderator,
                    history.slice(-6),
                    latestState.activeExperts.map(expert => expert.role),
                    farmerJustSpoke,
                    {
                        turnNumber: Math.min(latestState.totalAutonomousTurnsTaken + 1, latestState.maxAutonomousTurns),
                        turnBudget: latestState.maxAutonomousTurns,
                    },
                );
                latestState = getConversationState(this.conversationId)!;
                if (latestState.wasInterrupted) continue;
                if (latestState.mode === "paused" || latestState.turnChainScheduled) return;
                if (latestState.pendingMentionRoutes.some(route => route.sourceRole === null) ||
                    (latestState.lastUserMessage !== routingMessage && latestState.farmerJustSpoke)) continue;
                state = latestState;
                if (farmerJustSpoke) updateConversationState(this.conversationId, { farmerJustSpoke: false });

                // A farmer input must receive a routed speaker even when the
                // Moderator would otherwise close the round.
                if (suggestedRole === "Conclude" && state.pendingUserMessage) {
                    suggestedRole = "RoundRobin";
                }
                break;
            }

            if (nextExpertIndex === -1) {
                if (suggestedRole === null && !state.moderatorNoticeSent) {
                    updateConversationState(this.conversationId, { moderatorNoticeSent: true });
                    state.broadcastFn(this.conversationId, {
                        type: "notice", conversationId: this.conversationId,
                        message: "Moderator unavailable — speaking in round-robin."
                    });
                }
                if (suggestedRole === "Conclude") {
                    debugLog(`Orchestrator: Moderator concluded the discussion for ${this.conversationId} — streaming the closing synthesis.`);
                    state.broadcastFn(this.conversationId, { type: "concluding", conversationId: this.conversationId });
                    updateConversationState(this.conversationId, { turnInFlight: true });
                    try {
                        await generateClosingSynthesis(this.conversationId, moderator, state.broadcastFn);
                        concludeSynthesisDelivered = true;
                    } finally {
                        updateConversationState(this.conversationId, { turnInFlight: false });
                    }
                } else if (suggestedRole && suggestedRole !== "RoundRobin") {
                    const startIndex = (state.currentExpertIndex + 1) % state.activeExperts.length;
                    for (let i = 0; i < state.activeExperts.length; i++) {
                        const checkIndex = (startIndex + i) % state.activeExperts.length;
                        if (state.activeExperts[checkIndex].role === suggestedRole) {
                            nextExpertIndex = checkIndex;
                            break;
                        }
                    }
                    if (nextExpertIndex === -1) {
                        console.warn(`Moderator suggested role ${suggestedRole} not found, falling back to round robin.`);
                        nextExpertIndex = (state.currentExpertIndex + 1) % state.activeExperts.length;
                    }
                } else {
                    nextExpertIndex = (state.currentExpertIndex + 1) % state.activeExperts.length;
                }
            }
        } else { // processing_sequential
            nextExpertIndex = state.currentExpertIndex + 1;
        }

        const beforeTurnState = getConversationState(this.conversationId);
        if (beforeTurnState?.wasInterrupted) {
            const pendingMessage = beforeTurnState.lastUserMessage;
            updateConversationState(this.conversationId, {
                mode: "idle", wasInterrupted: false, currentExpertIndex: -1,
                totalAutonomousTurnsTaken: 0, pausedFromMode: null,
                pendingMentionRoutes: [], pendingUserMessage: pendingMessage,
                farmerJustSpoke: true, singleTurnOnly: false, lastUserMessage: pendingMessage
            });
            if (pendingMessage) scheduleInterruptedMessage(beforeTurnState, pendingMessage, true);
            return;
        }
        if (beforeTurnState?.mode === "paused" || beforeTurnState?.turnChainScheduled) return;
        if (beforeTurnState?.mode === "autonomous" && !beforeTurnState.isAutonomousEnabled) {
            if (beforeTurnState.pendingUserMessage && beforeTurnState.totalAutonomousTurnsTaken < beforeTurnState.maxAutonomousTurns) {
                updateConversationState(this.conversationId, { singleTurnOnly: true });
            } else if (!beforeTurnState.singleTurnOnly) {
                updateConversationState(this.conversationId, {
                    mode: "idle", currentExpertIndex: -1, totalAutonomousTurnsTaken: 0,
                    singleTurnOnly: false, pendingUserMessage: null,
                    pendingMentionRoutes: [], farmerJustSpoke: false
                });
                generateInsights(this.conversationId, beforeTurnState.broadcastFn).catch(console.error);
                return;
            }
        }

        // 2. Check if processing should stop based on index or limits
        let endOfProcessing = false;
        // G4: sequential rounds iterate roundExperts (the addressed subset
        // when the user @-tagged experts); autonomous turns iterate the FULL
        // activeExperts (council-wide extension).
        if (state.mode === "processing_sequential" && nextExpertIndex >= state.roundExperts.length) {
            debugLog("End of sequential round detected.");
            endOfProcessing = true; // Will decide transition/stop later
            nextExpertIndex = -1; // Signal end of round
        } else if (state.mode === "autonomous" && state.totalAutonomousTurnsTaken >= state.maxAutonomousTurns) {
            debugLog(`Reached max autonomous turns (${state.maxAutonomousTurns}).`);
            endOfProcessing = true;
            nextExpertIndex = -1; // Signal stop
        }

        // 3. Process Expert Turn (if not stopping and index is valid)
        if (nextExpertIndex !== -1) {
            const currentExpert = state.mode === "processing_sequential"
                ? state.roundExperts[nextExpertIndex]
                : state.activeExperts[nextExpertIndex]; // Guaranteed to exist now

            const currentUserContext = state.pendingUserMessage;
            const priorTurnIndex = state.currentExpertIndex;
            const priorTurnCount = state.totalAutonomousTurnsTaken;

            // --- Update State for the Current Turn --- 
            const turnsTakenUpdate = state.mode === "autonomous" && state.totalAutonomousTurnsTaken < state.maxAutonomousTurns
                ? { totalAutonomousTurnsTaken: state.totalAutonomousTurnsTaken + 1 } 
                : {};
            state = updateConversationState(this.conversationId, { 
                currentExpertIndex: nextExpertIndex, 
                ...turnsTakenUpdate 
            });
            if (!state) return;
            const broadcastFn = state.broadcastFn;

            // --- Determine Reference Message --- 
            let referenceMessageContent = "";
            // If sequential, use the triggering user message
             if (state.mode === "processing_sequential") {
                 if (!state.lastUserMessage) {
                     console.error(`Orchestrator: Missing lastUserMessage in sequential mode. Cannot proceed.`);
                     updateConversationState(this.conversationId, { mode: "idle" }); return;
                 } 
                 referenceMessageContent = state.lastUserMessage.content;
            } 
            // A queued farmer message is the current prompt context. Otherwise
            // an autonomous turn follows the latest expert contribution.
             else if (state.mode === "autonomous") {
                const history = await storage.getConversationMessages(this.conversationId);
                if (currentUserContext) {
                    referenceMessageContent = currentUserContext.content;
                } else {
                    // Find the last non-error assistant message
                    const lastExpertMessage = history.slice().reverse().find(isRealExpertHistoryMessage);
                    if (!lastExpertMessage) {
                     // Should ideally not happen after sequential round, but handle defensively
                        console.error(`Orchestrator: Could not find previous expert message for autonomous turn ${state.totalAutonomousTurnsTaken}. Falling back to generic prompt.`);
                        referenceMessageContent = "Please continue the discussion based on the conversation history.";
                    } else {
                        referenceMessageContent = lastExpertMessage.content;
                    }
                }
            }
             // Defensive check if reference content is still empty
             if (!referenceMessageContent) {
                 console.error(`Orchestrator: Failed to determine reference message content. Mode: ${state.mode}. Stopping.`);
                 updateConversationState(this.conversationId, { mode: "idle" }); return;
             }
            
            debugLog(`Orchestrator turn: Expert ${currentExpert.name} (Index: ${nextExpertIndex}, Mode: ${state.mode}, Auto Turn: ${state.totalAutonomousTurnsTaken}/${state.maxAutonomousTurns})`);

            // --- Call Expert (STREAMING) --- 
            try {
                const history = await storage.getConversationMessages(this.conversationId);
                const files = await storage.getConversationFiles(this.conversationId);

                const latestState = getConversationState(this.conversationId);
                if (!latestState) return;
                if (latestState.wasInterrupted) {
                    const pendingMessage = latestState.lastUserMessage;
                    updateConversationState(this.conversationId, {
                        mode: "idle", wasInterrupted: false, currentExpertIndex: -1,
                        totalAutonomousTurnsTaken: 0, pausedFromMode: null,
                        pendingMentionRoutes: [], pendingUserMessage: pendingMessage,
                        farmerJustSpoke: true, singleTurnOnly: false, lastUserMessage: pendingMessage
                    });
                    if (pendingMessage) scheduleInterruptedMessage(latestState, pendingMessage, true);
                    return;
                }
                if (latestState.mode === "paused" || latestState.turnChainScheduled) {
                    // No expert has started yet, so a pure pause does not bill
                    // the selected turn or mark its queued input as picked up.
                    updateConversationState(this.conversationId, {
                        currentExpertIndex: priorTurnIndex,
                        totalAutonomousTurnsTaken: priorTurnCount,
                        pendingUserMessage: latestState.pendingUserMessage ?? currentUserContext
                    });
                    return;
                }

                const promptContext = latestState.pendingUserMessage ?? currentUserContext;
                if (promptContext) {
                    referenceMessageContent = promptContext.content;
                    state.broadcastFn(this.conversationId, {
                        type: "message_picked_up",
                        conversationId: this.conversationId,
                        messageId: promptContext.id
                    });
                }
                const pendingUpdate = latestState.pendingUserMessage === promptContext
                    ? { pendingUserMessage: null }
                    : {};
                state = updateConversationState(this.conversationId, {
                    ...pendingUpdate,
                    turnInFlight: true
                });
                if (!state) return;

                // G9 legibility: preview immediately before this expert
                // starts streaming, with the same expert identity.
                state.broadcastFn(this.conversationId, {
                    type: "next_speaker",
                    conversationId: this.conversationId,
                    expertId: currentExpert.id,
                    expertRole: currentExpert.role,
                });
                
                // Broadcast "expert started typing"
                state.broadcastFn(this.conversationId, {
                    type: "expert_stream_start",
                    expertId: currentExpert.id,
                    expertName: currentExpert.name,
                    expertRole: currentExpert.role,
                });

                // Mark the turn in flight before invoking the provider so a
                // pause or join now lets this selected expert finish.
                const expertResponse: InsertMessage = await getExpertResponseStream(
                    currentExpert, history, referenceMessageContent, files, availableRoles,
                    (token) => {
                        // Stream each token to the client
                        broadcastFn(this.conversationId, {
                            type: "expert_stream_token",
                            expertId: currentExpert.id,
                            token: token,
                        });
                    }
                );
                
                // Store and broadcast completed message
                const storedExpertMessage = await storage.createMessage(expertResponse);
                if (storedExpertMessage.role === "assistant" && storedExpertMessage.mentions?.includes("User")) {
                    const farmerQuestions = extractFarmerQuestions(storedExpertMessage.content);
                    if (farmerQuestions.length > 0) {
                        const broadcastQuestionStatus = state.broadcastFn;
                        const saves = Promise.allSettled(farmerQuestions.map(draft => Promise.resolve().then(() =>
                            storage.createOpenQuestion({
                                conversationId: this.conversationId,
                                messageId: storedExpertMessage.id,
                                expertRole: currentExpert.role,
                                question: draft.question,
                                assumption: draft.assumption,
                            })
                        )));
                        // Ledger I/O runs in the background so even a slow or
                        // unavailable question store cannot stall this turn
                        // chain. The expert message is already durable and
                        // the room continues from its stated assumption.
                        void saves.then(results => {
                            const savedAny = results.some(result => result.status === "fulfilled");
                            const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
                            for (const failure of failures) {
                                console.error(`Orchestrator: Could not save farmer question for conversation ${this.conversationId}:`, failure.reason);
                            }
                            if (savedAny) {
                                broadcastQuestionStatus(this.conversationId, {
                                    type: "open_questions_updated",
                                    conversationId: this.conversationId,
                                });
                            }
                            if (failures.length > 0) {
                                broadcastQuestionStatus(this.conversationId, {
                                    type: "notice",
                                    conversationId: this.conversationId,
                                    message: "A question for you could not be saved, but the council will continue.",
                                });
                            }
                        });
                    }
                }
                const latestAfterStore = getConversationState(this.conversationId);
                if (latestAfterStore) {
                    updateConversationState(this.conversationId, storedExpertMessage.role === "assistant" ? {
                        scheduledFailureAttempts: 0,
                            pendingMentionRoutes: [
                                ...latestAfterStore.pendingMentionRoutes,
                                ...mentionRoutesForMessage(storedExpertMessage.mentions, currentExpert.role, latestAfterStore.activeExperts)
                            ]
                    } : {});
                }
                state.broadcastFn(this.conversationId, {
                    type: "expert_stream_done",
                    expertId: currentExpert.id,
                    message: storedExpertMessage,
                });
                debugLog(`Orchestrator broadcasted streamed response from ${currentExpert.name}`);

                // --- F2 redundancy early-stop ---
                // Track every real expert contribution of this sequence, and —
                // in autonomous mode only (the sequential round is never cut) —
                // flag the sequence for early stop when the new message is
                // near-identical to a prior expert message. The stop itself is
                // applied in "Decide Next Action" below with the same cleanup
                // as a natural end. Interruptions/pauses take precedence.
                const isRealExpertContent = storedExpertMessage.role === "assistant" &&
                    !storedExpertMessage.content.startsWith("(Error");
                const postTurnState = getConversationState(this.conversationId);
                if (postTurnState && isRealExpertContent) {
                    if (postTurnState.mode === "autonomous") {
                        const decision = shouldStopForRedundancy(
                            storedExpertMessage.content,
                            postTurnState.sequenceExpertContents,
                            REDUNDANCY_STOP_SIMILARITY_THRESHOLD
                        );
                        if (decision.stop) {
                            redundancyStopDetected = true;
                            console.log(`Orchestrator: Redundancy early-stop for ${this.conversationId} — turn from ${currentExpert.name} is ${Math.round(decision.maxSimilarity * 100)}% similar to a prior expert message in this sequence (threshold ${REDUNDANCY_STOP_SIMILARITY_THRESHOLD}). Ending the autonomous sequence early.`);
                        }
                    }
                    postTurnState.sequenceExpertContents.push(storedExpertMessage.content);
                }
            } catch (error) {
                 console.error(`Orchestrator: Error streaming expert ${currentExpert.name}:`, error);
                 // Persist the failure so it survives refetches — a cache-only
                 // synthetic message vanishes on the next conversation load.
                 let errorMessage: Message | undefined;
                 try {
                     errorMessage = await storage.createMessage({
                         conversationId: this.conversationId,
                         expertId: currentExpert.id,
                         userId: null,
                         content: `(Error getting response from ${currentExpert.name}. Please try again.)`,
                         role: "assistant",
                         expertName: currentExpert.name,
                     });
                 } catch (storeError) {
                     console.error("Orchestrator: Failed to store error message:", storeError);
                 }
                state.broadcastFn(this.conversationId, {
                    type: "message_error", expertId: currentExpert.id,
                    expertName: currentExpert.name, message: errorMessage ?? `Error getting response from ${currentExpert.name}.`
                });
                // A rejected turn ends that attempt, but must not discard an
                // ordinary farmer message that joined while it was streaming.
                // Explicit /new remains the only path that resets the session.
                this.handleScheduledFailure(error);
                return;
            } finally {
                // The turn (or its failure) is fully handled — no longer in flight.
                updateConversationState(this.conversationId, { turnInFlight: false });
            }
        } // End if(nextExpertIndex !== -1)

        // 4. Decide Next Action (Schedule next turn or transition/stop)
        debugLog(`[DEBUG] Decide Next Action for ${this.conversationId} | Current Mode: ${state.mode} | Last Expert Index: ${state.currentExpertIndex} | Next Calculated Index: ${nextExpertIndex} | Auto Turns: ${state.totalAutonomousTurnsTaken}/${state.maxAutonomousTurns}`);
        const currentState = getConversationState(this.conversationId);
        if (!currentState) {
             console.error(`[DEBUG] State missing in Decide Next Action for ${this.conversationId}. Aborting.`);
             return; 
        }

        let continueProcessing = false;
        let processingEndedNaturally = false; // Use a flag to signal natural stop vs. transition
        const wasEndOfSequentialRound = currentState.mode === "processing_sequential" && nextExpertIndex === -1;
        debugLog(`[DEBUG] wasEndOfSequentialRound = ${wasEndOfSequentialRound}`);
        
        if (wasEndOfSequentialRound) {
            debugLog(`[DEBUG] Checking condition: isAutonomousEnabled=${currentState.isAutonomousEnabled}, maxAutonomousTurns=${currentState.maxAutonomousTurns}`);
            if (currentState.pendingUserMessage && currentState.totalAutonomousTurnsTaken < currentState.maxAutonomousTurns) {
                updateConversationState(this.conversationId, {
                    mode: "autonomous", currentExpertIndex: -1,
                    singleTurnOnly: !currentState.isAutonomousEnabled
                });
                continueProcessing = true;
            } else if (currentState.isAutonomousEnabled && currentState.maxAutonomousTurns > 0) {
                debugLog("Orchestrator: Sequential round finished. Switching to Autonomous mode."); // KEEP
                updateConversationState(this.conversationId, { 
                    mode: "autonomous", currentExpertIndex: -1, 
                    totalAutonomousTurnsTaken: 0, lastUserMessage: null 
                }); 
                continueProcessing = true;
                debugLog("[DEBUG] Set continueProcessing = true (Transitioning to Auto)");
            } else {
                debugLog("Orchestrator: Sequential round finished. Autonomous disabled. Setting to idle."); // KEEP
                processingEndedNaturally = true; 
                 debugLog("[DEBUG] Set processingEndedNaturally = true (Auto Disabled/Limit 0)");
            }
        } else if (currentState.mode === "autonomous") {
             debugLog("[DEBUG] Currently in Autonomous mode. Checking limits...");
             // The cap is absolute. Below it, pending farmer input takes
             // precedence over disabled autonomy, redundancy, and Conclude so
             // its next routed response stays in this same sequence.
             if (currentState.totalAutonomousTurnsTaken >= currentState.maxAutonomousTurns) {
                 debugLog("Orchestrator: Reached max autonomous turns. Setting mode to idle.");
                 processingEndedNaturally = true;
             } else if (currentState.pendingUserMessage) {
                 updateConversationState(this.conversationId, {
                     singleTurnOnly: !currentState.isAutonomousEnabled
                 });
                 continueProcessing = true;
             } else if (currentState.singleTurnOnly) {
                 processingEndedNaturally = true;
             } else if (!currentState.isAutonomousEnabled) {
                 debugLog("Autonomous disabled mid-round — ending sequence naturally.");
                 processingEndedNaturally = true;
             }
             // F2: a redundant autonomous answer ends the sequence with the
             // same cleanup as a natural end (idle + insights). Joined farmer
             // messages are handled above before redundancy can end the run.
             else if (redundancyStopDetected && !currentState.wasInterrupted) {
                 debugLog("Orchestrator: Autonomous sequence stopped early (redundant answer). Setting mode to idle.");
                 processingEndedNaturally = true;
             }
             // G5: the closing synthesis turn already ran inline; end the
             // sequence with the same cleanup as a natural end (idle +
             // insights). A joined farmer message takes precedence above and
             // is routed after synthesis finishes.
             else if (concludeSynthesisDelivered && !currentState.wasInterrupted) {
                 debugLog("Orchestrator: Closing synthesis delivered — ending sequence naturally.");
                 processingEndedNaturally = true;
             } else {
                 continueProcessing = true; // Continue autonomous processing
                 debugLog("[DEBUG] Set continueProcessing = true (Continuing Auto)");
             }
        } else if (currentState.mode === "processing_sequential" && nextExpertIndex !== -1) {
             // Continue sequential if we processed a turn and it wasn't the end signal
             continueProcessing = true;
             debugLog("[DEBUG] Set continueProcessing = true (Continuing Sequential)");
        }

        // Final actions if processing ended naturally
        if (processingEndedNaturally) {
             debugLog("[DEBUG] Processing ended naturally. Updating state to idle and generating insights.");
             updateConversationState(this.conversationId, {
                 mode: "idle", currentExpertIndex: -1, totalAutonomousTurnsTaken: 0,
                 pausedFromMode: null, singleTurnOnly: false, pendingUserMessage: null,
                 pendingMentionRoutes: [], farmerJustSpoke: false
             });
             generateInsights(this.conversationId, state.broadcastFn).catch(console.error);
             continueProcessing = false; // Ensure we don't schedule next turn
        }
        
        // Schedule next turn if decided and not paused/interrupted
        // Re-fetch state one last time before scheduling to ensure mode wasn't changed by pause/interrupt
        const finalStateCheck = getConversationState(this.conversationId);
         debugLog(`[DEBUG] Final check before scheduling: continueProcessing=${continueProcessing}, finalMode=${finalStateCheck?.mode}, finalInterrupted=${finalStateCheck?.wasInterrupted}`);
        if (continueProcessing && finalStateCheck && finalStateCheck.mode !== "paused" && !finalStateCheck.wasInterrupted) {
            debugLog("[DEBUG] Scheduling next turn via setImmediate.");
            // Claim the single scheduled-chain slot before yielding.
            updateConversationState(this.conversationId, { turnChainScheduled: true });
            setImmediate(() => {
                 this.processNextTurn().catch(err => {
                     this.handleScheduledFailure(err);
                 });
            });
        } else {
             // Use the already fetched finalStateCheck here
             debugLog(`Orchestrator: Not scheduling next turn for ${this.conversationId}. Final State Mode: ${finalStateCheck?.mode}, Continue: ${continueProcessing}, Interrupted: ${finalStateCheck?.wasInterrupted}.`); // KEEP
             if (finalStateCheck?.wasInterrupted) {
                  const pendingMessage = finalStateCheck.lastUserMessage;
                  updateConversationState(this.conversationId, {
                      mode: "idle",
                      wasInterrupted: false,
                      currentExpertIndex: -1,
                      totalAutonomousTurnsTaken: 0,
                      pausedFromMode: null,
                      pendingMentionRoutes: [],
                      pendingUserMessage: pendingMessage,
                      farmerJustSpoke: true,
                      singleTurnOnly: false,
                      lastUserMessage: pendingMessage
                  });
                  if (pendingMessage) {
                      scheduleInterruptedMessage(finalStateCheck, pendingMessage, true);
                  }
                  return;
             }
             // If we aren't continuing and weren't paused/interrupted, ensure state is idle
             if (finalStateCheck && finalStateCheck.mode !== 'paused' && !finalStateCheck.wasInterrupted && !continueProcessing) {
                  debugLog("[DEBUG] Setting state to idle because not continuing and not paused/interrupted.");
                  updateConversationState(this.conversationId, { mode: "idle" });
             }
        }
        } finally {
            const finishedState = getConversationState(this.conversationId);
            if (finishedState?.turnChainRunning) {
                updateConversationState(this.conversationId, { turnChainRunning: false });
            }
        }
    }

    // --- Control Methods ---
    pause(): void {
        const state = getConversationState(this.conversationId);
        if (state && (state.mode === "processing_sequential" || state.mode === "autonomous")) {
            debugLog(`Orchestrator pausing conversation ${this.conversationId}`);
            updateConversationState(this.conversationId, { mode: "paused", pausedFromMode: state.mode });
        } else {
             debugLog(`Orchestrator: Cannot pause conversation ${this.conversationId}. Current mode: ${state?.mode}`);
        }
    }

    resume(): void {
        const state = getConversationState(this.conversationId);
        if (state && state.mode === "paused") {
            debugLog(`Orchestrator resuming conversation ${this.conversationId}`);
            // Resume the phase that was paused. The autonomous setting controls
            // the sequential-to-autonomous transition, not an already-running phase.
            const resumeToMode = state.pausedFromMode === "processing_sequential" || state.pausedFromMode === null
                ? "autonomous"
                : state.pausedFromMode;
            const chainAlreadyOwnsFlow = state.turnChainRunning || state.turnChainScheduled;
            updateConversationState(this.conversationId, {
                mode: resumeToMode,
                pausedFromMode: null,
                ...(!chainAlreadyOwnsFlow ? { turnChainScheduled: true } : {})
            });

            // The suspended chain will observe the resumed mode after its
            // current await. Reuse a pending callback too, instead of racing
            // it with another processNextTurn invocation.
            if (chainAlreadyOwnsFlow) return;

            // Trigger the next turn processing immediately
            setImmediate(() => {
                this.processNextTurn().catch(err => {
                    this.handleScheduledFailure(err);
                });
           });
        } else {
             debugLog(`Orchestrator: Cannot resume conversation ${this.conversationId}. Current mode: ${state?.mode}`);
        }
    }

    // --- Autonomous Control Methods ---
    setTurnBudget(turnBudget: number | null): void {
        const state = getConversationState(this.conversationId);
        if (!state) return;
        updateConversationState(this.conversationId, {
            maxAutonomousTurns: effectiveTurnBudget(turnBudget),
        });
    }

    enableAutonomous(maxTurns?: number | null): void {
        const state = getConversationState(this.conversationId);
        if (!state) return;

        const newMaxTurns = maxTurns === undefined
            ? state.maxAutonomousTurns
            : maxTurns === null || maxTurns === 0
                ? MAX_TURN_BUDGET
                : typeof maxTurns === "number" && Number.isFinite(maxTurns) && maxTurns >= 1
                    ? Math.min(MAX_TURN_BUDGET, Math.floor(maxTurns))
                    : DEFAULT_TURN_BUDGET;

        debugLog(`Orchestrator enabling autonomous mode for ${this.conversationId} (max ${newMaxTurns} turns)`);
        updateConversationState(this.conversationId, { 
            isAutonomousEnabled: true,
            maxAutonomousTurns: newMaxTurns
            // We don't reset turnsTaken here, only when a new sequence starts or auto round completes
        });
        // Note: This doesn't automatically start processing if idle/paused.
        // User might enable auto, then send a message or resume.
    }

    disableAutonomous(): void {
        const state = getConversationState(this.conversationId);
        if (!state) return;
        
        debugLog(`Orchestrator disabling autonomous mode for ${this.conversationId} — any running sequence ends naturally after the current expert.`);
        updateConversationState(this.conversationId, { 
            isAutonomousEnabled: false,
            // Optionally reset maxAutonomousTurns to 0 or keep the value?
            // maxAutonomousTurns: 0 
        });
        // Never pause here: pausing mid-round wedged the conversation (a
        // paused state had nothing to resume it). "Decide Next Action" in
        // processNextTurn ends the sequence naturally once the current
        // expert finishes (idle + insights).
    }

}

// Central function called from routes.ts
export async function processMessageTurnBased(
    userId: number, 
    conversationId: number, 
    userMessage: Message, 
    broadcastFn: (convId: number, data: any) => void,
    options: { restart?: boolean } = {}
): Promise<void> {
    try {
        const explicitRestart = options.restart === true;
        // Get current state and experts
        let state = getConversationState(conversationId);
        const roster = await storage.getConversationExperts(conversationId);
        if (!roster || roster.length === 0) {
            debugLog(`No experts assigned to conversation ${conversationId}. Cannot process message.`);
            return;
        }
        const { activeExperts, moderatorExpert } = partitionExpertRoster(conversationId, roster);
        if (activeExperts.length === 0) {
            debugLog(`No speakable experts assigned to conversation ${conversationId}. Cannot process message.`);
            return;
        }

        const stateIsStale = state &&
            ((state.mode === "processing_sequential" || state.mode === "autonomous") &&
                (!isUsableConversationState(state) || Date.now() - state.lastProgressAt > STALE_PROCESSING_MS));

        if (!isUsableConversationState(state) || stateIsStale) {
            if (state) {
                console.warn(`Recovering stale or partial orchestrator state for conversation ${conversationId}.`);
            }
            // G7 cold-start reconstruction: with no in-memory state, the
            // snapshot persisted by the previous process tells us what died.
            // processing_sequential/autonomous is a dead turn chain — it
            // cannot be revived, so recover honestly to idle (the
            // initialization below persists the corrected snapshot). paused
            // is real, recoverable state: initialize, then restore paused
            // through updateConversationState so the paused state_update
            // reaches the client badge. idle/null/absent snapshots keep the
            // previous behavior exactly. A stale-but-present in-memory state
            // keeps its existing recovery semantics regardless of the row.
            let storedSnapshot: OrchestratorSnapshot | null = null;
            let configuredBudget: number | null | undefined;
            if (typeof storage.getConversation === "function") {
                try {
                    const conversationRow = await storage.getConversation(conversationId);
                    configuredBudget = conversationRow?.turnBudget;
                    if (!state) storedSnapshot = conversationRow?.orchestratorState ?? null;
                } catch (error) {
                    // A settings read failure must not lose the already-stored
                    // farmer message. Continue safely with the default budget.
                    console.error(`Orchestrator: Could not read conversation settings/snapshot for ${conversationId}; using safe budget defaults:`, error);
                }
            }
            if (!state) {
                if (storedSnapshot && (storedSnapshot.mode === "processing_sequential" || storedSnapshot.mode === "autonomous")) {
                    console.warn(`Orchestrator: conversation ${conversationId} snapshot says "${storedSnapshot.mode}" from before a restart — the turn chain died with the old process. Recovering to idle.`);
                }
            }
            // Initialize if first message for this server instance, or recover
            // from a state left behind by a crashed loop.
            state = initializeConversationState(
                conversationId,
                activeExperts,
                moderatorExpert,
                userMessage,
                broadcastFn,
                effectiveTurnBudget(configuredBudget),
            );
            if (storedSnapshot) {
                // Restore the configured autonomy and cap even when a dead
                // processing chain is mapped to idle. This preserves settings
                // across a cold start without reviving the dead chain.
                state = updateConversationState(conversationId, {
                    isAutonomousEnabled: snapshotBooleanOrDefault(
                        storedSnapshot.isAutonomousEnabled,
                        state.isAutonomousEnabled,
                    ),
                    maxAutonomousTurns: snapshotBudgetOrFallback(
                        storedSnapshot.maxAutonomousTurns,
                        configuredBudget,
                    ),
                });
            }
            if (storedSnapshot?.mode === "paused") {
                updateConversationState(conversationId, {
                    mode: "paused",
                    pausedFromMode: restoredPausedFromMode(storedSnapshot.pausedFromMode),
                    currentExpertIndex: Number.isInteger(storedSnapshot.currentExpertIndex)
                        ? storedSnapshot.currentExpertIndex
                        : -1,
                    totalAutonomousTurnsTaken: Number.isInteger(storedSnapshot.totalAutonomousTurnsTaken)
                        ? storedSnapshot.totalAutonomousTurnsTaken
                        : 0,
                });
                state = getConversationState(conversationId)!;
            }
        }

        state = getConversationState(conversationId)!;
        const isActive = state.mode === "processing_sequential" || state.mode === "autonomous";

        // An explicit restart discards earlier joined context and counters.
        // Ordinary messages below join the active sequence in place.
        if (explicitRestart && (isActive || state.mode === "paused")) {
            updateConversationState(conversationId, {
                activeExperts,
                moderatorExpert,
                lastUserMessage: userMessage,
                pendingUserMessage: userMessage,
                pendingMentionRoutes: [],
                farmerJustSpoke: true,
                singleTurnOnly: false,
                wasInterrupted: true,
                scheduledFailureAttempts: 0
            });
            broadcastFn(conversationId, { type: "steering" });
            state = getConversationState(conversationId)!;
            if (state.mode === "paused" && !state.turnInFlight) {
                updateConversationState(conversationId, {
                    mode: "idle",
                    wasInterrupted: false,
                    currentExpertIndex: -1,
                    totalAutonomousTurnsTaken: 0,
                    pausedFromMode: null,
                    lastUserMessage: userMessage,
                    scheduledFailureAttempts: 0
                });
                await new InteractionOrchestrator(conversationId).startProcessingSequence();
            }
            return;
        }

        if (isActive || state.mode === "paused") {
            const newFarmerRoutes = mentionRoutesForMessage(userMessage.mentions, null, activeExperts);
            const existingFarmerRoutes = state.pendingMentionRoutes.filter(route => route.sourceRole === null);
            const existingExpertRoutes = state.pendingMentionRoutes.filter(route => route.sourceRole !== null);
            const joined = updateConversationState(conversationId, {
                activeExperts,
                moderatorExpert,
                lastUserMessage: userMessage,
                pendingUserMessage: userMessage,
                pendingMentionRoutes: [...existingFarmerRoutes, ...newFarmerRoutes, ...existingExpertRoutes],
                farmerJustSpoke: true
            });
            broadcastFn(conversationId, {
                type: "message_queued",
                conversationId,
                messageId: userMessage.id
            });
            if (state.mode === "paused") {
                // Resume the exact parked phase/index/counters. If its turn is
                // still streaming, the scheduled chain yields to that owner.
                new InteractionOrchestrator(conversationId).resume();
            }
            debugLog(`User message joined active sequence for ${conversationId} (mode: ${joined.mode}).`);
            return;
        }

        // Idle input starts a fresh sequence with the new topic and roster.
        updateConversationState(conversationId, {
            activeExperts,
            moderatorExpert,
            lastUserMessage: userMessage,
            pendingUserMessage: userMessage,
            pendingMentionRoutes: [],
            farmerJustSpoke: true,
            singleTurnOnly: false,
            wasInterrupted: false,
            ...(explicitRestart ? { scheduledFailureAttempts: 0 } : {})
        });
        state = getConversationState(conversationId)!;

        // A message while paused is now handled by the in-place join above.
        // This branch is retained only as a defensive invariant check.
        if (state.mode === "paused") {
            new InteractionOrchestrator(conversationId).resume();
            return;
        }

        // Only start processing if the orchestrator is currently idle.
        if (state.mode === "idle") {
            const orchestrator = new InteractionOrchestrator(conversationId);
            await orchestrator.startProcessingSequence(); 
        } else {
            // Defensive: paused now restarts via the implicit-resume path
            // above; this branch should not be reachable.
            debugLog(`Orchestrator for ${conversationId} is not idle (mode: ${state.mode}). New message queued in state.`);
        }

    } catch (error) {
        console.error(`Error in processMessageTurnBased for conversation ${conversationId}:`, error);
        broadcastFn(conversationId, { type: "error", message: "Failed to process message." });
    }
}

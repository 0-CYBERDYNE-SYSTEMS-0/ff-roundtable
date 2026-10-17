import { storage } from "./storage";
import { getExpertResponse, getExpertResponseStream, generateInsights, getModeratorNextSpeakerSuggestion, generateClosingSynthesis, resolveAuxModel } from "./ai";
import type { DeliverableGenerationRequest, ModeratorContext } from "./ai";
import { isNearDuplicate, shouldStopForRedundancy, REDUNDANCY_STOP_SIMILARITY_THRESHOLD } from "./text-similarity";
import { enforceTurnFairness } from "./turn-fairness";
import { commitPendingDeliverable, discardPendingDeliverable } from "./pending-deliverables";
import type { InsertMessage, Expert, Message, File, MessageStance, OrchestratorSnapshot } from "@shared/schema";
import { extractFarmerQuestions } from "@shared/mentions";
import { createHash } from "crypto";

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

type HandoffStatus = "not_started" | "in_progress" | "delivered";

interface ConversationState {
    conversationId: number;
    // Speakable, persisted experts only. The system Moderator has its own
    // context below and must never occupy a turn index or roster position.
    activeExperts: Expert[];
    moderatorExpert: ModeratorContext;
    currentExpertIndex: number;
    lastUserMessage: Message | null; // Store the user message that triggered the sequence
    // Keep the active file request while later farmer messages refine it.
    sequenceFileCreatorRequest?: Message | null;
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
    // Experts that failed or returned no usable answer in this in-memory run.
    // They are skipped for the rest of this run and reset at a fresh run.
    failedExpertIds: number[];
    // Legacy G4 snapshot field. New G11 sequences route mentions through the
    // pending FIFO and leave this list empty; Moderator is never in it.
    roundExperts: Expert[];
    // G4 ping-pong guard: the unordered role pair ("A<B", sorted) of the last
    // mention-routed turn plus how many consecutive mention-routed turns that
    // pair has logged. null whenever the previous turn was not mention-routed.
    mentionPairStreak: { key: string; count: number } | null;
    // G15: current-question stance ledger. Each speakable expert role is
    // present with null until it supplies a valid stance for this question.
    stanceQuestionMessageId: number | null;
    stanceLedger: Record<string, MessageStance | null>;
    // A cycle is complete when every active expert has finished one turn.
    // Two consecutive matching camp signatures make a split stable.
    stanceCycleRoles: string[];
    stableSplitSignature: string | null;
    stableSplitCycleCount: number;
    // Disagreement is queued until that expert receives a follow-up turn.
    dissentersNeedingTurn: string[];
    // G8 aux hygiene: the "Moderator unavailable — speaking in round-robin."
    // notice is broadcast at most ONCE PER SEQUENCE. Set when the notice goes
    // out; reset when a new sequence starts (startProcessingSequence /
    // initializeConversationState). In-memory only — never part of the G7
    // snapshot.
    moderatorNoticeSent: boolean;
    // In-memory run boundary for terminal synthesis. Omitted from snapshots:
    // an active run is recovered as fresh after a process restart.
    handoffStatus: HandoffStatus;
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

type StanceLedger = Record<string, MessageStance | null>;

function emptyStanceLedger(activeExperts: Expert[]): StanceLedger {
    return Object.fromEntries(activeExperts.map(expert => [expert.role, null]));
}

function isMessageStance(value: unknown): value is MessageStance {
    if (!value || typeof value !== "object") return false;
    const stance = value as Partial<MessageStance>;
    return ["agree", "disagree", "conditional", "abstain"].includes(String(stance.stance).toLowerCase()) &&
        Number.isInteger(stance.confidence) && Number(stance.confidence) >= 1 && Number(stance.confidence) <= 5 &&
        typeof stance.position === "string";
}

/** Convergence excludes abstentions and requires at least one substantive stance. */
export function isStanceLedgerConverged(ledger: StanceLedger): boolean {
    const substantive = Object.values(ledger).filter((stance): stance is MessageStance =>
        Boolean(stance && stance.stance !== "abstain")
    );
    return substantive.length > 0 && substantive.every(stance =>
        stance.stance === "agree" || stance.stance === "conditional"
    );
}

/** Stable split means the same named experts occupy both camps for two cycles. */
export function getStableStanceSplitSignature(ledger: StanceLedger): string | null {
    const aligned = Object.entries(ledger)
        .filter(([, stance]) => stance?.stance === "agree" || stance?.stance === "conditional")
        .map(([role]) => role)
        .sort();
    const dissenting = Object.entries(ledger)
        .filter(([, stance]) => stance?.stance === "disagree")
        .map(([role]) => role)
        .sort();
    if (aligned.length === 0 || dissenting.length === 0) return null;
    return JSON.stringify({ aligned, dissenting });
}

/** Pure, testable gate: convergence, a stable split after 80%, or the hard cap. */
export function canConcludeWithStanceEvidence(
    ledger: StanceLedger,
    turnsTaken: number,
    effectiveBudget: number,
    stableSplitCycleCount: number,
    stableSplitSignature: string | null,
): boolean {
    if (turnsTaken >= effectiveBudget) return true;
    if (isStanceLedgerConverged(ledger)) return true;
    const threshold = Math.ceil(0.8 * effectiveBudget);
    const currentSignature = getStableStanceSplitSignature(ledger);
    return turnsTaken >= threshold && stableSplitCycleCount >= 2 && currentSignature !== null &&
        currentSignature === stableSplitSignature;
}

const MINIMUM_AUTONOMOUS_TURNS_PER_EXPERT_BEFORE_CONCLUSION = 2;

function countPostQuestionTurnsByExpert(
    history: Message[],
    activeExperts: Expert[],
    questionMessageId: number | null,
): Map<number, number> {
    const turnsByExpert = new Map(activeExperts.map(expert => [expert.id, 0]));
    for (const message of history) {
        if (message.expertId === null || (questionMessageId !== null && message.id <= questionMessageId)) continue;
        if (turnsByExpert.has(message.expertId)) {
            turnsByExpert.set(message.expertId, (turnsByExpert.get(message.expertId) ?? 0) + 1);
        }
    }
    return turnsByExpert;
}

/** Find the next role still owed a contribution, preserving roster order. */
export function nextExpertNeedingMinimumTurns(
    history: Message[],
    activeExperts: Expert[],
    questionMessageId: number | null,
    currentExpertIndex: number,
    minimumTurnsPerExpert = MINIMUM_AUTONOMOUS_TURNS_PER_EXPERT_BEFORE_CONCLUSION,
): string | null {
    if (!Number.isInteger(minimumTurnsPerExpert) || minimumTurnsPerExpert < 1 || activeExperts.length === 0) {
        return null;
    }

    const turnsByExpert = countPostQuestionTurnsByExpert(history, activeExperts, questionMessageId);
    for (let offset = 1; offset <= activeExperts.length; offset++) {
        const index = ((currentExpertIndex + offset) % activeExperts.length + activeExperts.length) % activeExperts.length;
        const expert = activeExperts[index];
        if ((turnsByExpert.get(expert.id) ?? 0) < minimumTurnsPerExpert) return expert.role;
    }
    return null;
}

/** A natural conclusion must give each speakable role two chances to contribute. */
export function haveAllExpertsSpokenMinimumTurns(
    history: Message[],
    activeExperts: Expert[],
    questionMessageId: number | null,
    minimumTurnsPerExpert = MINIMUM_AUTONOMOUS_TURNS_PER_EXPERT_BEFORE_CONCLUSION,
): boolean {
    if (!Number.isInteger(minimumTurnsPerExpert) || minimumTurnsPerExpert < 1 || activeExperts.length === 0) {
        return false;
    }

    return nextExpertNeedingMinimumTurns(
        history,
        activeExperts,
        questionMessageId,
        -1,
        minimumTurnsPerExpert,
    ) === null;
}

function resetStanceEvidence(userMessage: Message, activeExperts: Expert[]) {
    return {
        stanceQuestionMessageId: Number.isInteger(userMessage.id) ? userMessage.id : null,
        stanceLedger: emptyStanceLedger(activeExperts),
        stanceCycleRoles: [] as string[],
        stableSplitSignature: null,
        stableSplitCycleCount: 0,
        dissentersNeedingTurn: [] as string[],
    };
}

function stanceStateForRestoredQuestion(messages: Message[], activeExperts: Expert[]) {
    const ledger = emptyStanceLedger(activeExperts);
    const latestQuestionIndex = messages.map(message => message.role).lastIndexOf("user");
    const latestQuestion = latestQuestionIndex >= 0 ? messages[latestQuestionIndex] : null;
    if (!latestQuestion) {
        return { stanceQuestionMessageId: null, stanceLedger: ledger, dissentersNeedingTurn: [] as string[] };
    }
    // Message rows do not persist which question a turn began answering. A
    // turn already in flight when a newer farmer message arrived can therefore
    // be stored after that newer message. On cold restore, keep the question
    // anchor but fail closed on all stance evidence instead of attributing a
    // stale turn to the wrong question.
    return {
        stanceQuestionMessageId: Number.isInteger(latestQuestion.id) ? latestQuestion.id : null,
        stanceLedger: ledger,
        dissentersNeedingTurn: [] as string[],
    };
}

function completedTurnStanceUpdates(
    state: ConversationState,
    expertRole: string,
    stanceValue: unknown,
    questionMessageId: number | null,
): Partial<ConversationState> {
    // A response drafted before a newer farmer question arrived belongs to
    // that old question. Keep its stored message, but do not feed it into the
    // active question's decision ledger.
    if (state.stanceQuestionMessageId !== questionMessageId || !(expertRole in state.stanceLedger)) return {};

    const stance = isMessageStance(stanceValue) ? stanceValue : null;
    const previousStance = state.stanceLedger[expertRole];
    const stanceLedger = { ...state.stanceLedger, [expertRole]: stance };
    const dissentersNeedingTurn = state.dissentersNeedingTurn.filter(role => role !== expertRole);
    if (stance?.stance === "disagree" && previousStance?.stance !== "disagree") {
        dissentersNeedingTurn.push(expertRole);
    }

    const cycleRoles = new Set([...state.stanceCycleRoles, expertRole]);
    const completeCycle = state.activeExperts.every(expert => cycleRoles.has(expert.role));
    if (!completeCycle) {
        return {
            stanceLedger,
            dissentersNeedingTurn,
            stanceCycleRoles: Array.from(cycleRoles),
        };
    }

    const signature = getStableStanceSplitSignature(stanceLedger);
    if (signature === null) {
        return {
            stanceLedger,
            dissentersNeedingTurn,
            stanceCycleRoles: [],
            stableSplitSignature: null,
            stableSplitCycleCount: 0,
        };
    }
    const stableSplitCycleCount = signature === state.stableSplitSignature
        ? state.stableSplitCycleCount + 1
        : 1;
    return {
        stanceLedger,
        dissentersNeedingTurn,
        stanceCycleRoles: [],
        stableSplitSignature: signature,
        stableSplitCycleCount,
    };
}

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
        sequenceFileCreatorRequestId: state.sequenceFileCreatorRequest?.id ?? null,
    };
}

function snapshotsDiffer(a: OrchestratorSnapshot, b: OrchestratorSnapshot): boolean {
    return a.mode !== b.mode ||
        a.currentExpertIndex !== b.currentExpertIndex ||
        a.totalAutonomousTurnsTaken !== b.totalAutonomousTurnsTaken ||
        a.wasInterrupted !== b.wasInterrupted ||
        a.pausedFromMode !== b.pausedFromMode ||
        a.isAutonomousEnabled !== b.isAutonomousEnabled ||
        a.maxAutonomousTurns !== b.maxAutonomousTurns ||
        a.sequenceFileCreatorRequestId !== b.sequenceFileCreatorRequestId;
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
const openQuestionWritePromises: Map<number, Set<Promise<void>>> = new Map();

function trackOpenQuestionWrite(conversationId: number, write: Promise<void>): void {
    const writes = openQuestionWritePromises.get(conversationId) ?? new Set<Promise<void>>();
    writes.add(write);
    openQuestionWritePromises.set(conversationId, writes);
    const removeWrite = () => {
        writes.delete(write);
        if (writes.size === 0) openQuestionWritePromises.delete(conversationId);
    };
    void write.then(removeWrite, removeWrite);
}

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
        Array.isArray(state.failedExpertIds) && state.failedExpertIds.every(id => Number.isInteger(id)) &&
        Array.isArray(state.roundExperts) &&
        state.roundExperts.every(e => isSpeakableExpertRole(e.role)) &&
        (state.stanceQuestionMessageId === null || Number.isInteger(state.stanceQuestionMessageId)) &&
        Boolean(state.stanceLedger && typeof state.stanceLedger === "object" && !Array.isArray(state.stanceLedger)) &&
        Object.values(state.stanceLedger ?? {}).every(stance => stance === null || isMessageStance(stance)) &&
        Array.isArray(state.stanceCycleRoles) && state.stanceCycleRoles.every(role => typeof role === "string") &&
        (state.stableSplitSignature === null || typeof state.stableSplitSignature === "string") &&
        Number.isInteger(state.stableSplitCycleCount) && state.stableSplitCycleCount >= 0 &&
        Array.isArray(state.dissentersNeedingTurn) && state.dissentersNeedingTurn.every(role => typeof role === "string") &&
        // G8/G10: fields initializeConversationState always sets must be asserted
        // here (established invariant) — a partial/stale state object missing
        // one is re-initialized instead of limping through the sequence.
        typeof state.moderatorNoticeSent === "boolean" &&
        ["not_started", "in_progress", "delivered"].includes(state.handoffStatus)
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

function extractLabeledFarmerQuestions(content: string): Array<{ question: string; assumption: string | null }> {
    const lines = content.split(/\r?\n/);
    const questions: Array<{ question: string; assumption: string | null }> = [];
    const seen = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim().replace(/^[-*+]\s+/, "");
        const match = line.match(/^Farmer question\s*:\s*(.+\?)\s*$/i);
        const question = match?.[1]?.trim();
        if (!question || question === "?" || seen.has(question)) continue;

        const assumptionLine = (lines[i + 1] ?? "").trim().replace(/^[-*+]\s+/, "");
        const assumption = assumptionLine.match(/^(?:Assumption|Assuming)\s*:?\s*(.+?)\s*$/i)?.[1]?.trim() || null;
        seen.add(question);
        questions.push({ question, assumption });
        if (assumption) i++;
    }

    return questions;
}

type FarmerFileIntent = "retrieve" | "no_file" | null;

function cleanFarmerFileText(content: string | null | undefined): string {
    return (content ?? "")
        .toLowerCase()
        .replace(/[’‘]/g, "'")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`[^`]*`/g, " ")
        .replace(/^\s*>.*$/gm, " ")
        .replace(/[“\"][^”\"]*[”\"]/g, " ")
        .replace(/https?:\/\/\S+/g, " ");
}

function classifyFarmerFileIntent(content: string | null | undefined): FarmerFileIntent {
    if (!content) return null;
    const text = cleanFarmerFileText(content);
    const fileNoun = "(?:files?|documents?|sops?|calendars?|spreadsheets?|exports?)";

    if (
        new RegExp(`\\b(?:stop|don't|do not|no longer)\\b.{0,60}\\b(?:create|make|generate|draft|write|produce|attach|export|save|creating|making|generating|drafting|writing|producing|attaching|exporting|saving)\\b.{0,60}\\b${fileNoun}\\b`).test(text) ||
        new RegExp(`\\bno (?:more|new|additional) ${fileNoun}\\b`).test(text) ||
        /\bno\s+(?:file|document)\s+(?:creation|generation|output)\b/.test(text) ||
        /\b(?:stop|disable)\s+(?:file|document)\s+(?:creation|generation)\b/.test(text)
    ) {
        return "no_file";
    }

    // A request that creates or revises an artifact may also ask for its link.
    // Keep that work in the generation path; only a retrieval-only message is
    // fulfilled directly from stored files.
    if (/\b(?:create|make|generate|draft|write|produce|prepare|revise|update|modify|export|save)\b.{0,80}\b(?:files?|documents?|sops?|calendars?|spreadsheets?|exports?)\b/.test(text)) {
        return null;
    }

    if (
        /\b(?:just|only)\s+(?:(?:want|need)\s+)?(?:(?:send|give|share|show|provide)\s+)?(?:me\s+)?(?:the\s+)?(?:download\s+)?link\b/.test(text) ||
        new RegExp(`\\b(?:get|retrieve|download|open|find|share|send|give|show|provide)\\b.{0,60}\\b(?:existing|saved|current|latest)?\\s*${fileNoun}\\b`).test(text) ||
        /\b(?:get|retrieve|download|open|find|share|send|give|show|provide)\b.{0,40}\b(?:the\s+)?(?:download\s+)?link\b/.test(text) ||
        /\b(?:existing|saved|current|latest)\b.{0,30}\b(?:file|document|sop|calendar)\b.{0,30}\b(?:link|download)\b/.test(text)
    ) {
        return "retrieve";
    }

    return null;
}

/** Latest-message file intent shared with routes for retrieval-only replies. */
export function getFarmerFileIntent(content: string | null | undefined): FarmerFileIntent {
    return classifyFarmerFileIntent(content);
}

function isFileCreatorRole(role: string): boolean {
    return role.trim().toLowerCase() === "file creator";
}

function filterFileCreatorRoutes(
    routes: PendingMentionRoute[],
    farmerContent: string | null | undefined,
    hasOutstandingRequest = false,
): PendingMentionRoute[] {
    return isFileCreatorAllowed(farmerContent, hasOutstandingRequest)
        ? routes
        : routes.filter(route => !isFileCreatorRole(route.role));
}

function blocksFileCreator(fileIntent: FarmerFileIntent): boolean {
    return fileIntent === "retrieve" || fileIntent === "no_file";
}

function isFileCreatorAllowed(content: string | null | undefined, hasOutstandingRequest = false): boolean {
    const text = cleanFarmerFileText(content);
    if (!text || blocksFileCreator(classifyFarmerFileIntent(text))) return false;
    const fileNoun = "(?:files?|documents?|sops?|calendars?|spreadsheets?|exports?|plans?|scripts?|code)";
    return hasOutstandingRequest ||
        new RegExp(`\\b(?:create|make|generate|draft|write|produce|prepare|export|build|turn|convert|provide|give|need|want|revise|update|edit|modify|replace|change|adjust|save)\\b.{0,80}\\b${fileNoun}\\b`).test(text);
}

function nextSequenceFileCreatorRequest(
    existingRequest: Message | null | undefined,
    message: Message | null | undefined,
): Message | null {
    if (!message) return existingRequest ?? null;
    if (blocksFileCreator(classifyFarmerFileIntent(message.content))) return null;
    return isFileCreatorAllowed(message.content) ? message : existingRequest ?? null;
}

const DELIVERABLE_NUMBER_WORDS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function inferDeliverableKind(content: string): string {
    const matches = Array.from(content.toLowerCase().matchAll(/\b(sop|standard operating procedure|calendar|spreadsheet|csv|chart|plan|budget|script|code|document)\b/g));
    return matches[0]?.[1] === "standard operating procedure" ? "sop" : (matches[0]?.[1] ?? "document");
}

function inferDeliverableConstraints(content: string): DeliverableGenerationRequest["constraints"] {
    const text = content.toLowerCase();
    const constraints: DeliverableGenerationRequest["constraints"] = {};
    const parseLimit = (value: string): number => {
        const normalized = value.toLowerCase().replace(/,/g, "").trim();
        return normalized.endsWith("k") ? Number(normalized.slice(0, -1)) * 1000 : Number(normalized);
    };
    const lessThan = text.match(/\b(?:under|less than|below)\s+([\d,]+(?:\.\d+)?\s*k?)\s*(?:unicode\s+)?characters?\b/);
    const atMost = text.match(/\b(?:at most|no more than|up to)\s+([\d,]+(?:\.\d+)?\s*k?)\s*(?:unicode\s+)?characters?\b/);
    const characterLimit = lessThan ? Math.ceil(parseLimit(lessThan[1])) - 1 : atMost ? Math.floor(parseLimit(atMost[1])) : undefined;
    if (characterLimit !== undefined && characterLimit >= 0) constraints.maxCharacters = characterLimit;

    const taskCountMatch = text.match(/\b(?:exactly\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(dated\s+)?tasks?\b/);
    if (taskCountMatch) {
        const count = Number(taskCountMatch[1]) || DELIVERABLE_NUMBER_WORDS[taskCountMatch[1]];
        if (count > 0) constraints.taskCount = count;
        if (taskCountMatch[2]) constraints.datedTasks = true;
    }

    const sectionList = text.match(/\b(?:include|with|required)\s+(?:the\s+following\s+)?sections?\s*:?\s*([^.!?\n]+)/);
    if (sectionList) {
        const sections = sectionList[1]
            .replace(/\s+and\s+/g, ",")
            .split(",")
            .map(section => section.trim().replace(/^[-*]\s*/, ""))
            .filter(Boolean);
        if (sections.length) constraints.requiredSections = sections;
    }
    if (constraints.taskCount !== undefined && !constraints.requiredSections) constraints.requiredSections = ["Tasks"];

    const explicitExtension = text.match(/\.([a-z0-9]{2,5})\b/)?.[1];
    const knownFormats: Array<[RegExp, string]> = [
        [/\b(?:markdown|md)\b/, "Markdown"], [/\b(?:plain text|text file|txt)\b/, "Text"],
        [/\b(?:csv|spreadsheet|excel|xlsx)\b/, "CSV"], [/\b(?:json)\b/, "JSON"],
        [/\b(?:html|web page)\b/, "HTML"], [/\b(?:calendar|ics)\b/, "ICS"],
        [/\b(?:pdf|docx|word document|python|javascript|typescript)\b/, text.match(/\b(?:pdf|docx|python|javascript|typescript)\b/)?.[0] ?? "Word document"],
    ];
    if (explicitExtension) {
        constraints.format = explicitExtension;
    } else {
        constraints.format = knownFormats.find(([pattern]) => pattern.test(text))?.[1];
    }
    if (!constraints.format) {
        const kind = inferDeliverableKind(content);
        if (kind === "sop" || constraints.taskCount !== undefined || constraints.requiredSections?.length) constraints.format = "Markdown";
        else if (kind === "calendar") constraints.format = "ICS";
        else if (kind === "spreadsheet" || kind === "csv") constraints.format = "CSV";
    }
    return constraints;
}

function deliverableIdentityTokens(content: string): string[] {
    const ignored = new Set([
        "a", "an", "and", "are", "as", "at", "be", "by", "can", "could", "create", "dated", "document",
        "do", "exactly", "file", "files", "for", "four", "give", "generate", "make", "me", "my", "of", "on",
        "please", "prepare", "provide", "request", "revise", "sop", "tasks", "the", "this", "to", "under", "update",
        "with", "write", "you", "your", "characters", "character", "less", "than", "more", "most", "at", "no",
    ]);
    return cleanFarmerFileText(content)
        .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
        .replace(/\b\d[\d,]*\b/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .split(/\s+/)
        .filter(token => token.length > 2 && !ignored.has(token));
}

function fileMatchesDeliverableKind(file: File, kind: string): boolean {
    const name = file.filename.toLowerCase();
    if (kind === "sop" || kind === "standard operating procedure") return /sop|procedure|\.md(?:$|\?)/.test(name);
    if (kind === "calendar") return /calendar|\.ics$/.test(name);
    if (kind === "spreadsheet" || kind === "csv") return /spreadsheet|\.csv$/.test(name);
    if (kind === "script" || kind === "code") return /script|code|\.(?:py|js|ts)$/.test(name);
    return name.includes(kind);
}

function selectRevisionTarget(files: File[], kind: string, content: string): File | undefined {
    const kindMatches = files.filter(file => fileMatchesDeliverableKind(file, kind));
    const candidates = kindMatches.length ? kindMatches : files;
    if (candidates.length === 1) return candidates[0];
    const requestTokens = new Set(deliverableIdentityTokens(content));
    const scored = candidates.map(file => ({
        file,
        score: file.filename.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(token => requestTokens.has(token)).length,
    })).sort((a, b) => b.score - a.score);
    return scored.length > 0 && scored[0].score > 0 && scored[0].score > (scored[1]?.score ?? 0)
        ? scored[0].file
        : undefined;
}

async function buildDeliverableGenerationRequest(
    conversationId: number,
    userMessage: Message,
    content: string,
): Promise<DeliverableGenerationRequest> {
    const kind = inferDeliverableKind(content);
    const revisionIntent = /\b(?:revise|revision|update|edit|modify|replace|change|adjust)\b/.test(cleanFarmerFileText(content));
    const currentFiles = await storage.getCurrentDeliverableFiles(conversationId);
    const revisionTarget = revisionIntent ? selectRevisionTarget(currentFiles, kind, content) : undefined;
    if (revisionIntent && !revisionTarget) {
        throw new Error("I couldn't identify which saved deliverable to revise. Please name the file or open the Files pane.");
    }

    const tokens = deliverableIdentityTokens(userMessage.content);
    const identity = tokens.join(" ") || `message-${userMessage.id}`;
    const deliverableId = revisionTarget?.deliverableId ?? `deliverable-${createHash("sha256")
        .update(`${conversationId}:${kind}:${identity}`)
        .digest("hex")
        .slice(0, 32)}`;
    const generationRequestId = `generation-${createHash("sha256")
        .update(`${conversationId}:${userMessage.id}:File Creator`)
        .digest("hex")
        .slice(0, 32)}`;
    return {
        deliverableId,
        generationRequestId,
        mode: revisionTarget ? "revise" : "create",
        ...(revisionTarget ? { expectedCurrentFileId: revisionTarget.id } : {}),
        constraints: inferDeliverableConstraints(content),
    };
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

// History scans must never mistake a stored failure or blank response for a
// real expert contribution. Orchestrator-stored provider errors start with
// "(Error getting response from", cached/legacy error rows start with
// "(Error generating response", and vision rejections start with "⚠️".
function isUsableExpertResponse(role: Message["role"], content: string): boolean {
    const trimmedContent = content.trim();
    return role === "assistant" &&
        trimmedContent.length > 0 &&
        !trimmedContent.startsWith("(Error") &&
        !trimmedContent.startsWith("⚠️");
}

// Per-sequence fairness memory, keyed by the sequence's
// sequenceExpertContents array: every new sequence (farmer message, restart,
// resume) starts with a fresh array, so this resets exactly when it should.
type SequenceFairness = { speakers: number[]; retired: Set<number> };
const sequenceFairness = new WeakMap<object, SequenceFairness>();
function fairnessFor(sequenceKey: object | undefined): SequenceFairness {
    if (!sequenceKey) return { speakers: [], retired: new Set() };
    let entry = sequenceFairness.get(sequenceKey);
    if (!entry) { entry = { speakers: [], retired: new Set() }; sequenceFairness.set(sequenceKey, entry); }
    return entry;
}
function messagesSinceLatestFarmer(history: Message[]): { farmerMessageId: number | null; expertMessages: Message[] } {
    let idx = -1;
    for (let i = history.length - 1; i >= 0; i--) if (history[i].role === "user") { idx = i; break; }
    return {
        farmerMessageId: idx >= 0 ? history[idx].id : null,
        expertMessages: history.slice(idx + 1).filter(m => m.expertId != null && isRealExpertHistoryMessage(m)),
    };
}

function isRealExpertHistoryMessage(m: Message): boolean {
    return isUsableExpertResponse(m.role, m.content);
}

function expertMessagesSinceLatestFarmer(messages: Message[]): Message[] {
    let latestFarmerIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].role === "user") {
            latestFarmerIndex = index;
            break;
        }
    }
    return messages.slice(latestFarmerIndex + 1).filter(message =>
        typeof message.expertId === "number" &&
        Number.isInteger(message.expertId) &&
        isRealExpertHistoryMessage(message),
    );
}

function nextHealthyExpertIndex(activeExperts: Expert[], currentIndex: number, failedExpertIds: number[]): number {
    for (let offset = 1; offset <= activeExperts.length; offset++) {
        const candidateIndex = (currentIndex + offset + activeExperts.length) % activeExperts.length;
        if (!failedExpertIds.includes(activeExperts[candidateIndex].id)) return candidateIndex;
    }
    return -1;
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
        newState.maxAutonomousTurns !== previousState.maxAutonomousTurns ||
        newState.totalAutonomousTurnsTaken !== previousState.totalAutonomousTurnsTaken) {
        const activeRun = newState.mode !== "idle";
        existingState.broadcastFn(conversationId, { 
            type: "state_update", 
            mode: newState.mode, 
            isAutonomousEnabled: newState.isAutonomousEnabled,
            maxAutonomousTurns: newState.maxAutonomousTurns,
            ...(activeRun ? {
                expertTurnsConsumed: newState.totalAutonomousTurnsTaken,
                expertTurnsRemaining: Math.max(0, newState.maxAutonomousTurns - newState.totalAutonomousTurnsTaken)
            } : {})
        });
        debugLog(`Broadcasted state update for ${conversationId}: mode=${newState.mode}, autoEnabled=${newState.isAutonomousEnabled}`);
    }

    return newState;
}

/** Persist autonomy controls for route handlers, including before a run has initialized. */
export async function persistAutonomySettings(
    conversationId: number,
    settings: { isAutonomousEnabled?: boolean; maxAutonomousTurns?: number | null }
): Promise<void> {
    if (settings.isAutonomousEnabled === undefined && settings.maxAutonomousTurns === undefined) return;

    const state = getConversationState(conversationId);
    if (state) {
        updateConversationState(conversationId, {
            ...(settings.isAutonomousEnabled === undefined ? {} : { isAutonomousEnabled: settings.isAutonomousEnabled }),
            ...(settings.maxAutonomousTurns === undefined ? {} : { maxAutonomousTurns: effectiveTurnBudget(settings.maxAutonomousTurns) })
        });
        await snapshotWriteChains.get(conversationId);
        return;
    }

    if (typeof storage.getConversation !== "function" || typeof storage.updateConversation !== "function") {
        throw new Error("Conversation storage is unavailable for persisting autonomy settings.");
    }

    await snapshotWriteChains.get(conversationId)?.catch(() => {});
    const conversationRow = await storage.getConversation(conversationId);
    const storedValue = conversationRow?.orchestratorState;
    const storedSnapshot = storedValue && typeof storedValue === "object" && !Array.isArray(storedValue)
        ? storedValue as OrchestratorSnapshot
        : null;
    const storedMode = storedSnapshot?.mode;
    const storedPausedFromMode = storedSnapshot?.pausedFromMode;
    const storedCurrentExpertIndex = storedSnapshot?.currentExpertIndex;
    const storedAutonomousTurnsTaken = storedSnapshot?.totalAutonomousTurnsTaken;
    const nextSnapshot: OrchestratorSnapshot = {
        ...(storedSnapshot ?? {}),
        mode: storedMode === "idle" || storedMode === "processing_sequential" || storedMode === "autonomous" || storedMode === "paused"
            ? storedMode
            : "idle",
        currentExpertIndex: typeof storedCurrentExpertIndex === "number" && Number.isInteger(storedCurrentExpertIndex)
            ? storedCurrentExpertIndex
            : -1,
        totalAutonomousTurnsTaken: typeof storedAutonomousTurnsTaken === "number" && Number.isInteger(storedAutonomousTurnsTaken) && storedAutonomousTurnsTaken >= 0
            ? storedAutonomousTurnsTaken
            : 0,
        wasInterrupted: typeof storedSnapshot?.wasInterrupted === "boolean" ? storedSnapshot.wasInterrupted : false,
        pausedFromMode: storedPausedFromMode === "processing_sequential" || storedPausedFromMode === "autonomous"
            ? storedPausedFromMode
            : null,
        isAutonomousEnabled: settings.isAutonomousEnabled ?? snapshotBooleanOrDefault(storedSnapshot?.isAutonomousEnabled, true),
        maxAutonomousTurns: settings.maxAutonomousTurns === undefined
            ? snapshotBudgetOrFallback(storedSnapshot?.maxAutonomousTurns, conversationRow?.turnBudget)
            : effectiveTurnBudget(settings.maxAutonomousTurns)
    };

    persistSnapshot(conversationId, nextSnapshot);
    await snapshotWriteChains.get(conversationId);
}

// Initialize state when orchestrator is first needed for a conversation
function initializeConversationState(conversationId: number, activeExperts: Expert[], moderatorExpert: ModeratorContext, userMessage: Message, broadcastFn: (convId: number, data: any) => void, maxAutonomousTurns = DEFAULT_TURN_BUDGET): ConversationState {
    const initialState: ConversationState = {
        conversationId,
        activeExperts,
        moderatorExpert,
        currentExpertIndex: -1, 
        lastUserMessage: userMessage,
        sequenceFileCreatorRequest: isFileCreatorAllowed(userMessage.content) ? userMessage : null,
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
        failedExpertIds: [],
        roundExperts: selectRoundExperts(activeExperts, userMessage.mentions),
        mentionPairStreak: null,
        ...resetStanceEvidence(userMessage, activeExperts),
        moderatorNoticeSent: false,
        handoffStatus: "not_started",
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
    // Recover the farmer context too, so File Creator can finish a saved request.
    const history = await Promise.resolve().then(() => storage.getConversationMessages(conversationId)).then(messages => messages ?? []).catch(error => {
        console.error(`Orchestrator: Could not rebuild context for paused conversation ${conversationId}:`, error);
        return [];
    });
    const farmerMessages = history.filter(message => message.role === "user");
    const lastUserMessage = farmerMessages.at(-1) ?? null;
    const fileRequest = storedSnapshot.sequenceFileCreatorRequestId === undefined
        ? nextSequenceFileCreatorRequest(null, lastUserMessage)
        : farmerMessages.find(message => message.id === storedSnapshot.sequenceFileCreatorRequestId) ?? null;
    const restored: ConversationState = {
        conversationId,
        activeExperts,
        moderatorExpert,
        currentExpertIndex: Number.isInteger(storedSnapshot.currentExpertIndex)
            ? storedSnapshot.currentExpertIndex
            : -1,
        lastUserMessage,
        sequenceFileCreatorRequest: fileRequest,
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
        failedExpertIds: [],
        roundExperts: activeExperts,
        mentionPairStreak: null,
        ...stanceStateForRestoredQuestion(history, activeExperts),
        stanceCycleRoles: [],
        stableSplitSignature: null,
        stableSplitCycleCount: 0,
        moderatorNoticeSent: false,
        handoffStatus: "not_started",
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

    private scheduleNextTurn(): void {
        updateConversationState(this.conversationId, { turnChainScheduled: true });
        setImmediate(() => {
            void this.processNextTurn().catch(error => {
                void this.handleScheduledFailure(error);
            });
        });
    }

    private beginQueuedRun(state: ConversationState, pendingMessage: Message): void {
        updateConversationState(this.conversationId, {
            mode: "autonomous",
            currentExpertIndex: -1,
            totalAutonomousTurnsTaken: 0,
            wasInterrupted: false,
            pausedFromMode: null,
            lastUserMessage: pendingMessage,
            sequenceFileCreatorRequest: isFileCreatorAllowed(pendingMessage.content) ? pendingMessage : null,
            pendingUserMessage: pendingMessage,
            pendingMentionRoutes: filterFileCreatorRoutes(
                mentionRoutesForMessage(pendingMessage.mentions, null, state.activeExperts),
                pendingMessage.content,
                isFileCreatorAllowed(pendingMessage.content),
            ),
            farmerJustSpoke: true,
            singleTurnOnly: !state.isAutonomousEnabled,
            turnInFlight: false,
            turnChainScheduled: false,
            scheduledFailureAttempts: 0,
            sequenceExpertContents: [],
            failedExpertIds: [],
            roundExperts: [],
            mentionPairStreak: null,
            ...resetStanceEvidence(pendingMessage, state.activeExperts),
            moderatorNoticeSent: false,
            handoffStatus: "not_started",
        });
    }

    private async recordExpertFailure(
        expert: Expert,
    ): Promise<Message | undefined> {
        let errorMessage: Message | undefined;
        try {
            errorMessage = await storage.createMessage({
                conversationId: this.conversationId,
                expertId: expert.id,
                userId: null,
                content: `(Error getting response from ${expert.name}. Please try again.)`,
                role: "assistant",
                expertName: expert.name,
            });
        } catch (storeError) {
            console.error("Orchestrator: Failed to store error message:", storeError);
        }

        const currentState = getConversationState(this.conversationId);
        if (!currentState) return errorMessage;
        updateConversationState(this.conversationId, {
            failedExpertIds: currentState.failedExpertIds.includes(expert.id)
                ? currentState.failedExpertIds
                : [...currentState.failedExpertIds, expert.id],
        });
        const latestState = getConversationState(this.conversationId);
        latestState?.broadcastFn(this.conversationId, {
            type: "message_error",
            expertId: expert.id,
            expertName: expert.name,
            message: errorMessage ?? `Error getting response from ${expert.name}.`,
        });
        return errorMessage;
    }

    private async emitClosingHandoff(): Promise<void> {
        let state = getConversationState(this.conversationId);
        if (!state || state.handoffStatus !== "not_started") return;

        const moderator = state.moderatorExpert;
        const broadcast = state.broadcastFn;
        const stanceLedger = state.stanceLedger;
        state = updateConversationState(this.conversationId, {
            handoffStatus: "in_progress",
            turnInFlight: true,
            // Input already pending at the terminal boundary belonged to the
            // capped run. Only messages arriving after this claim queue for
            // the fresh run that follows the handoff.
            pendingUserMessage: null,
            pendingMentionRoutes: [],
            farmerJustSpoke: false,
        });
        broadcast(this.conversationId, { type: "concluding", conversationId: this.conversationId });

        try {
            const pendingWrites = Array.from(openQuestionWritePromises.get(this.conversationId) ?? []);
            if (pendingWrites.length > 0) await Promise.allSettled(pendingWrites);
            await generateClosingSynthesis(this.conversationId, moderator, broadcast, stanceLedger);
        } catch (error) {
            console.error(`Orchestrator: Could not generate closing handoff for ${this.conversationId}:`, error);
            broadcast(this.conversationId, {
                type: "notice",
                conversationId: this.conversationId,
                message: "The council could not produce a closing handoff. The discussion and saved work remain available.",
            });
        } finally {
            updateConversationState(this.conversationId, {
                handoffStatus: "delivered",
                turnInFlight: false,
            });
        }
    }

    /** Close one run, then start a fresh bounded run for input queued during its handoff. */
    private async finishNaturalRun(): Promise<boolean> {
        let state = getConversationState(this.conversationId);
        if (!state || state.mode === "paused" || state.wasInterrupted) return false;

        if (state.handoffStatus === "not_started") await this.emitClosingHandoff();
        state = getConversationState(this.conversationId);
        if (!state || state.mode === "paused" || state.wasInterrupted) return false;

        if (state.pendingUserMessage) {
            this.beginQueuedRun(state, state.pendingUserMessage);
            generateInsights(this.conversationId, state.broadcastFn).catch(console.error);
            return true;
        }

        updateConversationState(this.conversationId, {
            mode: "idle",
            currentExpertIndex: -1,
            totalAutonomousTurnsTaken: 0,
            pausedFromMode: null,
            singleTurnOnly: false,
            pendingUserMessage: null,
            pendingMentionRoutes: [],
            farmerJustSpoke: false,
            turnInFlight: false,
        });
        generateInsights(this.conversationId, state.broadcastFn).catch(console.error);
        return false;
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
            sequenceFileCreatorRequest: isFileCreatorAllowed(state.lastUserMessage?.content) ? state.lastUserMessage : null,
            wasInterrupted: false, // Reset interrupted flag
            pausedFromMode: null,
            sequenceExpertContents: [], // New sequence: redundancy history starts empty
            failedExpertIds: [],
            // New discussions use the pending mention FIFO; roundExperts is
            // kept empty so routing never turns a mention into a forced roll
            // call.
            roundExperts: [],
            pendingMentionRoutes: filterFileCreatorRoutes(
                mentionRoutesForMessage(state.lastUserMessage?.mentions, null, state.activeExperts),
                state.lastUserMessage?.content,
                isFileCreatorAllowed(state.lastUserMessage?.content),
            ),
            pendingUserMessage: state.lastUserMessage,
            farmerJustSpoke: true,
            singleTurnOnly,
            mentionPairStreak: null, // New sequence: mention pair streak starts fresh
            ...(state.lastUserMessage ? resetStanceEvidence(state.lastUserMessage, state.activeExperts) : {}),
            moderatorNoticeSent: false, // New sequence: the G8 degradation notice may fire once more
            handoffStatus: "not_started",
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
                sequenceFileCreatorRequest: isFileCreatorAllowed(pendingMessage.content) ? pendingMessage : null,
                pendingMentionRoutes: filterFileCreatorRoutes(
                    mentionRoutesForMessage(pendingMessage.mentions, null, state.activeExperts),
                    pendingMessage.content,
                    isFileCreatorAllowed(pendingMessage.content),
                ),
                farmerJustSpoke: true,
                singleTurnOnly: !state.isAutonomousEnabled,
                sequenceExpertContents: [],
                failedExpertIds: [],
                roundExperts: [],
                mentionPairStreak: null,
                ...resetStanceEvidence(pendingMessage, state.activeExperts),
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
                     lastUserMessage: pendingMessage,
                     sequenceFileCreatorRequest: isFileCreatorAllowed(pendingMessage?.content) ? pendingMessage : null,
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
            }
        }
        if (state.mode === "autonomous" && !state.isAutonomousEnabled &&
            (!state.singleTurnOnly || (state.currentExpertIndex >= 0 && !state.pendingUserMessage))) {
            debugLog(`Orchestrator: autonomous disabled before turn start for ${this.conversationId} — ending sequence naturally.`);
            if (await this.finishNaturalRun()) this.scheduleNextTurn();
            return;
        }

        // 1. Determine the next expert index
        let nextExpertIndex = -1;
        // Set when the just-completed autonomous turn was redundant (F2) and
        // the sequence must stop early instead of scheduling another turn.
        let redundancyStopDetected = false;
        // Moderator conclusions share the same terminal handoff path as the
        // hard cap and other natural ends, so the handoff is claimed once.
        let moderatorConcluded = false;
        let expertResponseFailed = false;
        let selectedMentionRoute: PendingMentionRoute | null = null;
        // These are speakable expert roles only. The system Moderator advises
        // routing but is never a role the chair can select as a speaker.
        const availableRoles = state!.activeExperts
            .filter(expert => !state!.failedExpertIds.includes(expert.id))
            .map(expert => expert.role);

        if (state.mode === "autonomous" && availableRoles.length === 0) {
            moderatorConcluded = true;
        } else if (state.mode === "autonomous") {
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
                            farmerJustSpoke: true, singleTurnOnly: false, lastUserMessage: pendingMessage,
                            sequenceFileCreatorRequest: isFileCreatorAllowed(pendingMessage?.content) ? pendingMessage : null,
                        });
                        if (pendingMessage) scheduleInterruptedMessage(state, pendingMessage, true);
                    }
                    return;
                }
                if (state.mode === "paused" || state.turnChainScheduled) return;
                const filteredRoutes = filterFileCreatorRoutes(
                    state.pendingMentionRoutes,
                    state.lastUserMessage?.content,
                    Boolean(state.sequenceFileCreatorRequest),
                );
                if (filteredRoutes.length !== state.pendingMentionRoutes.length) {
                    state = updateConversationState(this.conversationId, { pendingMentionRoutes: filteredRoutes });
                }
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
                    if (candidateIndex < 0 || candidate.role === candidate.sourceRole ||
                        state.failedExpertIds.includes(state.activeExperts[candidateIndex].id)) continue;
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
                const history = (await storage.getConversationMessages(this.conversationId))
                    .filter(message => message.role !== "assistant" || isRealExpertHistoryMessage(message));
                let latestState = getConversationState(this.conversationId)!;
                if (latestState.wasInterrupted) continue;
                if (latestState.mode === "paused" || latestState.turnChainScheduled) return;
                if (latestState.pendingMentionRoutes.some(route => route.sourceRole === null) ||
                    (latestState.lastUserMessage !== routingMessage && latestState.farmerJustSpoke)) continue;

                suggestedRole = await getModeratorNextSpeakerSuggestion(
                    moderator,
                    history.slice(-6),
                    latestState.activeExperts
                        .filter(expert => !latestState.failedExpertIds.includes(expert.id))
                        .map(expert => expert.role),
                    farmerJustSpoke,
                    {
                        turnNumber: Math.min(latestState.totalAutonomousTurnsTaken + 1, latestState.maxAutonomousTurns),
                        turnBudget: latestState.maxAutonomousTurns,
                        stanceLedger: latestState.stanceLedger,
                    },
                );
                latestState = getConversationState(this.conversationId)!;
                if (latestState.wasInterrupted) continue;
                if (latestState.mode === "paused" || latestState.turnChainScheduled) return;
                if (latestState.pendingMentionRoutes.some(route => route.sourceRole === null) ||
                    (latestState.lastUserMessage !== routingMessage && latestState.farmerJustSpoke)) continue;
                state = latestState;
                if (suggestedRole && isFileCreatorRole(suggestedRole) &&
                    !isFileCreatorAllowed(state.lastUserMessage?.content, Boolean(state.sequenceFileCreatorRequest))) {
                    suggestedRole = "RoundRobin";
                }
                if (farmerJustSpoke) updateConversationState(this.conversationId, { farmerJustSpoke: false });

                // A farmer input must receive a routed speaker even when the
                // Moderator would otherwise close the round.
                if (suggestedRole === "Conclude" && state.pendingUserMessage) {
                    suggestedRole = "RoundRobin";
                }
                // Give every newly observed dissenter one explicit follow-up
                // before allowing a Moderator pick or a conclusion to pass.
                const forcedDissenter = state!.dissentersNeedingTurn.find(role =>
                    state!.activeExperts.some(expert => expert.role === role) &&
                    !state!.failedExpertIds.includes(state!.activeExperts.find(expert => expert.role === role)!.id) &&
                    state!.stanceLedger[role]?.stance === "disagree"
                );
                if (forcedDissenter && !state.pendingUserMessage) {
                    suggestedRole = forcedDissenter;
                } else if (
                    state.totalAutonomousTurnsTaken < state.maxAutonomousTurns &&
                    !state.pendingUserMessage &&
                    !haveAllExpertsSpokenMinimumTurns(
                        history,
                        state.activeExperts,
                        state.stanceQuestionMessageId,
                    )) {
                    // Keep the roster balanced before honoring any repeated
                    // Moderator pick or natural conclusion, not only Conclude.
                    const owedRole = nextExpertNeedingMinimumTurns(
                        history,
                        state.activeExperts,
                        state.stanceQuestionMessageId,
                        state.currentExpertIndex,
                    );
                    if (owedRole) {
                        if (suggestedRole !== owedRole) {
                            debugLog(`Orchestrator: minimum-turn routing override ${suggestedRole ?? "none"} -> ${owedRole} for ${this.conversationId}`);
                        }
                        suggestedRole = owedRole;
                    }
                } else if (suggestedRole === "Conclude" && !canConcludeWithStanceEvidence(
                    state.stanceLedger,
                    state.totalAutonomousTurnsTaken,
                    state.maxAutonomousTurns,
                    state.stableSplitCycleCount,
                    state.stableSplitSignature,
                )) {
                    // Keep the room moving. If there is no unaddressed
                    // dissenter, let the chair continue the roster cycle; a
                    // later Conclude is rechecked after each completed turn.
                    suggestedRole = "RoundRobin";
                }
                break;
            }

            if (nextExpertIndex === -1) {
                if (suggestedRole === null && availableRoles.length > 0 && !state.moderatorNoticeSent) {
                    updateConversationState(this.conversationId, { moderatorNoticeSent: true });
                    state.broadcastFn(this.conversationId, {
                        type: "notice", conversationId: this.conversationId,
                        message: "Moderator unavailable — speaking in round-robin."
                    });
                }
                if (suggestedRole === "Conclude") {
                    debugLog(`Orchestrator: Moderator concluded the discussion for ${this.conversationId}.`);
                    moderatorConcluded = true;
                } else if (suggestedRole && suggestedRole !== "RoundRobin") {
                    nextExpertIndex = state.activeExperts.findIndex(expert =>
                        expert.role === suggestedRole && !state!.failedExpertIds.includes(expert.id)
                    );
                    if (nextExpertIndex === -1) {
                        console.warn(`Moderator suggested role ${suggestedRole} not found, falling back to round robin.`);
                        nextExpertIndex = nextHealthyExpertIndex(
                            state.activeExperts,
                            state.currentExpertIndex,
                            state.failedExpertIds,
                        );
                    }
                } else {
                    nextExpertIndex = nextHealthyExpertIndex(
                        state.activeExperts,
                        state.currentExpertIndex,
                        state.failedExpertIds,
                    );
                }
            }
        } else { // processing_sequential
            nextExpertIndex = state.currentExpertIndex + 1;
            while (nextExpertIndex < state.roundExperts.length &&
                state.failedExpertIds.includes(state.roundExperts[nextExpertIndex].id)) {
                nextExpertIndex++;
            }
        }

        const beforeTurnState = getConversationState(this.conversationId);
        if (beforeTurnState?.wasInterrupted) {
            const pendingMessage = beforeTurnState.lastUserMessage;
            updateConversationState(this.conversationId, {
                mode: "idle", wasInterrupted: false, currentExpertIndex: -1,
                totalAutonomousTurnsTaken: 0, pausedFromMode: null,
                pendingMentionRoutes: [], pendingUserMessage: pendingMessage,
                farmerJustSpoke: true, singleTurnOnly: false, lastUserMessage: pendingMessage,
                sequenceFileCreatorRequest: isFileCreatorAllowed(pendingMessage?.content) ? pendingMessage : null,
            });
            if (pendingMessage) scheduleInterruptedMessage(beforeTurnState, pendingMessage, true);
            return;
        }
        if (beforeTurnState?.mode === "paused" || beforeTurnState?.turnChainScheduled) return;
        if (beforeTurnState?.mode === "autonomous" && !beforeTurnState.isAutonomousEnabled) {
            if (beforeTurnState.pendingUserMessage && beforeTurnState.totalAutonomousTurnsTaken < beforeTurnState.maxAutonomousTurns) {
                updateConversationState(this.conversationId, { singleTurnOnly: true });
            } else if (!beforeTurnState.singleTurnOnly) {
                if (await this.finishNaturalRun()) this.scheduleNextTurn();
                return;
            }
        }

        if (nextExpertIndex >= 0) {
            const selectedExpert = state.activeExperts[nextExpertIndex];
            if (selectedExpert && isFileCreatorRole(selectedExpert.role) &&
                !isFileCreatorAllowed(
                    beforeTurnState?.lastUserMessage?.content,
                    Boolean(beforeTurnState?.sequenceFileCreatorRequest),
                )) {
                nextExpertIndex = -1;
            }
        }

        // 1b. Turn fairness: every expert speaks before anyone repeats, nobody
        // speaks twice in a row, a farmer @mention is honoured once.
        const candidateExpert = nextExpertIndex >= 0 ? state.activeExperts[nextExpertIndex] : undefined;
        const fairness = fairnessFor(getConversationState(this.conversationId)?.sequenceExpertContents);
        const fileCreatorAlreadyDelivered = Boolean(candidateExpert && isFileCreatorRole(candidateExpert.role) &&
            fairness.speakers.includes(candidateExpert.id));
        if (state.mode === "autonomous" && candidateExpert && (!isFileCreatorRole(candidateExpert.role) || fileCreatorAlreadyDelivered)) {
            const speakers = fairness.speakers;
            // File Creator is an on-request utility, not a discussant; it is
            // governed by the File Creator gate, not by rotation.
            const rotation = state.activeExperts.filter(e => isSpeakableExpertRole(e.role) && !isFileCreatorRole(e.role));
            const excludedIds = [...state.failedExpertIds, ...Array.from(fairness.retired)];
            const fairId = enforceTurnFairness({
                rosterIds: rotation.map(e => e.id),
                excludedIds,
                speakersSinceFarmer: speakers.filter(id => rotation.some(e => e.id === id)),
                candidateId: fileCreatorAlreadyDelivered ? null : candidateExpert.id,
                isFarmerMentionRoute: selectedMentionRoute?.sourceRole === null,
                turnBudget: state.maxAutonomousTurns,
            });
            const fairIndex = fairId === null ? -1 : state.activeExperts.findIndex(e => e.id === fairId);
            if (fairIndex !== nextExpertIndex) {
                debugLog(`Orchestrator: fairness override ${candidateExpert.role} -> ${fairIndex >= 0 ? state.activeExperts[fairIndex].role : "stop"} for ${this.conversationId}`);
                nextExpertIndex = fairIndex;
                if (fairIndex === -1) moderatorConcluded = true;
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
            let turnQuestionMessageId: number | null = null;
            const countedAsAutonomousTurn = state.mode === "autonomous";
            let providerCallStarted = false;
            let providerCallResolved = false;

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
                const history = (await storage.getConversationMessages(this.conversationId))
                    .filter(message => message.role !== "assistant" || isRealExpertHistoryMessage(message));
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
                const history = (await storage.getConversationMessages(this.conversationId))
                    .filter(message => message.role !== "assistant" || isRealExpertHistoryMessage(message));
                const files = await storage.getConversationFiles(this.conversationId);

                const latestState = getConversationState(this.conversationId);
                if (!latestState) return;
                if (latestState.wasInterrupted) {
                    const pendingMessage = latestState.lastUserMessage;
                    updateConversationState(this.conversationId, {
                        mode: "idle", wasInterrupted: false, currentExpertIndex: -1,
                        totalAutonomousTurnsTaken: 0, pausedFromMode: null,
                        pendingMentionRoutes: [], pendingUserMessage: pendingMessage,
                        farmerJustSpoke: true, singleTurnOnly: false, lastUserMessage: pendingMessage,
                        sequenceFileCreatorRequest: isFileCreatorAllowed(pendingMessage?.content) ? pendingMessage : null,
                    });
                    if (pendingMessage) scheduleInterruptedMessage(latestState, pendingMessage, true);
                    return;
                }
                if (latestState.mode === "paused" || latestState.turnChainScheduled) {
                    // No expert has started yet, so a pure pause does not bill
                    // the selected turn or mark its queued input as picked up.
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
                // Match the input context used to form this prompt. A farmer
                // message that arrives during the stream resets the ledger and
                // makes this response historical for convergence purposes.
                turnQuestionMessageId = latestState.stanceQuestionMessageId;
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
                const fileCreatorSource = state.sequenceFileCreatorRequest;
                const deliverableContent = fileCreatorSource
                    ? history
                        .filter(message => message.role === "user" && message.id >= fileCreatorSource.id)
                        .map(message => message.content)
                        .join("\n\n")
                    : "";
                const deliverableRequest = isFileCreatorRole(currentExpert.role) && fileCreatorSource
                    ? await buildDeliverableGenerationRequest(
                        this.conversationId,
                        fileCreatorSource,
                        deliverableContent || fileCreatorSource.content,
                    )
                    : undefined;
                const existingCreate = deliverableRequest?.mode === "create"
                    ? await storage.getCurrentDeliverableFile(this.conversationId, deliverableRequest.deliverableId)
                    : undefined;
                const beforeDispatch = getConversationState(this.conversationId);
                if (!beforeDispatch) return;
                state = updateConversationState(this.conversationId, {
                    currentExpertIndex: nextExpertIndex,
                    ...(countedAsAutonomousTurn && beforeDispatch.totalAutonomousTurnsTaken < beforeDispatch.maxAutonomousTurns
                        ? { totalAutonomousTurnsTaken: beforeDispatch.totalAutonomousTurnsTaken + 1 }
                        : {}),
                });
                if (!state) return;
                let expertResponse: InsertMessage;
                if (existingCreate) {
                    const downloadUrl = `/api/protected/conversations/${this.conversationId}/files/${existingCreate.id}/download`;
                    const content = `Using existing file: ${existingCreate.filename} (version ${existingCreate.version ?? 1})\nDownload: ${downloadUrl}`;
                    broadcastFn(this.conversationId, {
                        type: "expert_stream_token",
                        expertId: currentExpert.id,
                        token: content,
                    });
                    expertResponse = {
                        conversationId: this.conversationId,
                        expertId: currentExpert.id,
                        userId: null,
                        content,
                        role: "assistant",
                        expertName: currentExpert.name,
                        expertRole: currentExpert.role,
                        artifacts: [],
                        mentions: [],
                        stance: null,
                    };
                } else {
                    providerCallStarted = true;
                    expertResponse = await getExpertResponseStream(
                        currentExpert, history, referenceMessageContent, files, availableRoles,
                        (token) => {
                            // Stream each token to the client
                            broadcastFn(this.conversationId, {
                                type: "expert_stream_token",
                                expertId: currentExpert.id,
                                token: token,
                            });
                        },
                        deliverableRequest,
                    );
                    providerCallResolved = true;
                }
                
                // Store and broadcast completed message
                let storedExpertMessage: Message | undefined;
                let discardedDuplicate = false;
                if (isUsableExpertResponse(expertResponse.role, expertResponse.content)) {
                    const turnFairness = fairnessFor(getConversationState(this.conversationId)?.sequenceExpertContents);
                    const priorContents = [
                        ...messagesSinceLatestFarmer(history).expertMessages.map(m => m.content),
                        ...(getConversationState(this.conversationId)?.sequenceExpertContents ?? []),
                    ];
                    if (state.mode === "autonomous" && !isFileCreatorRole(currentExpert.role) && isNearDuplicate(expertResponse.content, priorContents)) {
                        const turnsByExpert = countPostQuestionTurnsByExpert(
                            history,
                            state.activeExperts,
                            state.stanceQuestionMessageId,
                        );
                        const stillOwedMinimumTurn = (turnsByExpert.get(currentExpert.id) ?? 0) <
                            MINIMUM_AUTONOMOUS_TURNS_PER_EXPERT_BEFORE_CONCLUSION;
                        if (stillOwedMinimumTurn) {
                            // Preserve the minimum opportunity without repeating
                            // the duplicated claims or their deliverables.
                            expertResponse.content = "I don't have a distinct, evidence-supported point to add beyond the recommendations already shared, so I won't repeat them.";
                            expertResponse.artifacts = [];
                            expertResponse.mentions = [];
                            expertResponse.stance = null;
                            console.warn(`Orchestrator: replaced near-duplicate answer from ${currentExpert.role} in conversation ${this.conversationId} with a non-repeating minimum-turn response.`);
                            discardPendingDeliverable(expertResponse);
                        } else {
                            discardedDuplicate = true;
                            turnFairness.retired.add(currentExpert.id);
                            console.warn(`Orchestrator: discarded near-duplicate answer from ${currentExpert.role} in conversation ${this.conversationId}; retiring it until the farmer speaks.`);
                            broadcastFn(this.conversationId, { type: "expert_stream_done", expertId: currentExpert.id });
                            discardPendingDeliverable(expertResponse);
                        }
                    }
                    if (!discardedDuplicate) {
                        await commitPendingDeliverable(expertResponse, { farmerMessage: state.lastUserMessage ?? null });
                        storedExpertMessage = await storage.createMessage(expertResponse);
                        expertResponseFailed = !isRealExpertHistoryMessage(storedExpertMessage);
                        if (!expertResponseFailed) fairnessFor(getConversationState(this.conversationId)?.sequenceExpertContents).speakers.push(currentExpert.id);
                    }
                } else {
                    expertResponseFailed = true;
                }
                if (expertResponseFailed && !discardedDuplicate) {
                    storedExpertMessage = await this.recordExpertFailure(currentExpert);
                }
                if (storedExpertMessage?.role === "assistant" && !expertResponseFailed) {
                    const questionCandidates = [
                        ...extractFarmerQuestions(storedExpertMessage.content),
                        ...extractLabeledFarmerQuestions(storedExpertMessage.content),
                    ];
                    const seenQuestions = new Set<string>();
                    const farmerQuestions = questionCandidates.filter(draft => {
                        const key = draft.question.trim().toLowerCase();
                        if (seenQuestions.has(key)) return false;
                        seenQuestions.add(key);
                        return true;
                    });
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
                        // Keep the turn chain moving, but let a terminal handoff
                        // wait for this write so its prompt sees the persisted
                        // open-question ledger.
                        const write = saves.then(results => {
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
                        trackOpenQuestionWrite(this.conversationId, write);
                    }
                }
                const latestAfterStore = getConversationState(this.conversationId);
                if (latestAfterStore) {
                    updateConversationState(this.conversationId, storedExpertMessage?.role === "assistant" && !expertResponseFailed ? {
                        scheduledFailureAttempts: 0,
                        pendingMentionRoutes: filterFileCreatorRoutes([
                                ...latestAfterStore.pendingMentionRoutes,
                                ...mentionRoutesForMessage(storedExpertMessage.mentions, currentExpert.role, latestAfterStore.activeExperts)
                            ], latestAfterStore.lastUserMessage?.content, Boolean(latestAfterStore.sequenceFileCreatorRequest)),
                        ...completedTurnStanceUpdates(
                            latestAfterStore,
                            currentExpert.role,
                            storedExpertMessage.stance,
                            turnQuestionMessageId,
                        ),
                    } : {});
                }
                if (storedExpertMessage && !expertResponseFailed) {
                    state.broadcastFn(this.conversationId, {
                        type: "expert_stream_done",
                        expertId: currentExpert.id,
                        message: storedExpertMessage,
                    });
                    debugLog(`Orchestrator broadcasted streamed response from ${currentExpert.name}`);
                }

                // --- F2 redundancy early-stop ---
                // Track every real expert contribution of this sequence, and —
                // in autonomous mode only (the sequential round is never cut) —
                // flag the sequence for early stop when the new message is
                // near-identical to a prior expert message. The stop itself is
                // applied in "Decide Next Action" below with the same cleanup
                // as a natural end. Interruptions/pauses take precedence.
                const postTurnState = getConversationState(this.conversationId);
                if (postTurnState && storedExpertMessage && isRealExpertHistoryMessage(storedExpertMessage)) {
                    if (postTurnState.mode === "autonomous") {
                        const decision = shouldStopForRedundancy(
                            storedExpertMessage.content,
                            postTurnState.sequenceExpertContents,
                            REDUNDANCY_STOP_SIMILARITY_THRESHOLD
                        );
                        const minimumTurnsSatisfied = haveAllExpertsSpokenMinimumTurns(
                            [...history, storedExpertMessage],
                            postTurnState.activeExperts,
                            postTurnState.stanceQuestionMessageId,
                        );
                        if (decision.stop && minimumTurnsSatisfied) {
                            redundancyStopDetected = true;
                            console.log(`Orchestrator: Redundancy early-stop for ${this.conversationId} — turn from ${currentExpert.name} is ${Math.round(decision.maxSimilarity * 100)}% similar to a prior expert message in this sequence (threshold ${REDUNDANCY_STOP_SIMILARITY_THRESHOLD}). Ending the autonomous sequence early.`);
                        } else if (decision.stop) {
                            console.log(`Orchestrator: deferring redundancy early-stop for ${this.conversationId} until every active expert receives the minimum turns.`);
                        }
                    }
                    postTurnState.sequenceExpertContents.push(storedExpertMessage.content);
                }
            } catch (error) {
                if (providerCallStarted && !providerCallResolved) {
                    expertResponseFailed = true;
                    await this.recordExpertFailure(currentExpert);
                } else {
                    // Storage/preparation failures remain retryable chain
                    // failures. Do not close or discard joined farmer input.
                    this.handleScheduledFailure(error);
                    return;
                }
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
        } else if (expertResponseFailed && currentState.mode === "autonomous") {
             const allExpertsFailed = currentState.activeExperts.every(expert =>
                 currentState.failedExpertIds.includes(expert.id)
             );
             if (currentState.totalAutonomousTurnsTaken >= currentState.maxAutonomousTurns || allExpertsFailed) {
                 processingEndedNaturally = true;
             } else if (currentState.pendingUserMessage) {
                 updateConversationState(this.conversationId, {
                     singleTurnOnly: !currentState.isAutonomousEnabled
                 });
                 continueProcessing = true;
             } else if (currentState.singleTurnOnly || !currentState.isAutonomousEnabled) {
                 processingEndedNaturally = true;
             } else {
                 continueProcessing = true;
             }
        } else if (currentState.mode === "autonomous") {
             debugLog("[DEBUG] Currently in Autonomous mode. Checking limits...");
             // The cap is absolute. Below it, pending farmer input takes
             // precedence over disabled autonomy, redundancy, and Conclude so
             // its next routed response stays in this same sequence.
             if (currentState.handoffStatus !== "not_started") {
                 processingEndedNaturally = true;
             } else if (moderatorConcluded) {
                 processingEndedNaturally = true;
             } else if (currentState.totalAutonomousTurnsTaken >= currentState.maxAutonomousTurns) {
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
             debugLog("[DEBUG] Processing ended naturally. Starting the terminal handoff.");
             continueProcessing = await this.finishNaturalRun();
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
                      lastUserMessage: pendingMessage,
                      sequenceFileCreatorRequest: isFileCreatorAllowed(pendingMessage?.content) ? pendingMessage : null,
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
            const chainAlreadyOwnsFlow = state.turnChainRunning || state.turnChainScheduled;
            if (state.handoffStatus === "delivered" && !chainAlreadyOwnsFlow && !state.wasInterrupted) {
                if (state.pendingUserMessage) {
                    this.beginQueuedRun(state, state.pendingUserMessage);
                    generateInsights(this.conversationId, state.broadcastFn).catch(console.error);
                    this.scheduleNextTurn();
                } else {
                    updateConversationState(this.conversationId, {
                        mode: "idle",
                        currentExpertIndex: -1,
                        totalAutonomousTurnsTaken: 0,
                        pausedFromMode: null,
                        singleTurnOnly: false,
                        turnInFlight: false,
                    });
                    generateInsights(this.conversationId, state.broadcastFn).catch(console.error);
                }
                return;
            }
            // Resume the phase that was paused. The autonomous setting controls
            // the sequential-to-autonomous transition, not an already-running phase.
            const resumeToMode = state.pausedFromMode === "processing_sequential" || state.pausedFromMode === null
                ? "autonomous"
                : state.pausedFromMode;
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
        let explicitRestartBudget: number | undefined;
        let explicitRestartBudgetRead = false;
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
            let restoredSequenceFileCreatorRequest: Message | null | undefined;
            let configuredBudget: number | null | undefined;
            if (typeof storage.getConversation === "function") {
                try {
                    const conversationRow = await storage.getConversation(conversationId);
                    configuredBudget = conversationRow?.turnBudget;
                    if (explicitRestart) {
                        explicitRestartBudgetRead = true;
                        if (conversationRow) explicitRestartBudget = effectiveTurnBudget(configuredBudget);
                    }
                    if (!state) storedSnapshot = conversationRow?.orchestratorState ?? null;
                } catch (error) {
                    // A settings read failure must not lose the already-stored
                    // farmer message. Continue safely with the default budget.
                    console.error(`Orchestrator: Could not read conversation settings/snapshot for ${conversationId}; using safe budget defaults:`, error);
                    if (explicitRestart) explicitRestartBudgetRead = true;
                }
            }
            if (storedSnapshot?.mode === "paused" && !explicitRestart &&
                storedSnapshot.sequenceFileCreatorRequestId !== undefined) {
                restoredSequenceFileCreatorRequest = null;
                if (storedSnapshot.sequenceFileCreatorRequestId !== null) {
                    try {
                        const history = await storage.getConversationMessages(conversationId);
                        restoredSequenceFileCreatorRequest = history.find(message =>
                            message.id === storedSnapshot!.sequenceFileCreatorRequestId && message.role === "user"
                        ) ?? null;
                    } catch (error) {
                        console.error(`Orchestrator: Could not restore File Creator request for paused conversation ${conversationId}:`, error);
                    }
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
                    maxAutonomousTurns: explicitRestartBudget ?? snapshotBudgetOrFallback(
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
                    ...(restoredSequenceFileCreatorRequest === undefined
                        ? {}
                        : { sequenceFileCreatorRequest: restoredSequenceFileCreatorRequest }),
                });
                state = getConversationState(conversationId)!;
            }
        }

        state = getConversationState(conversationId)!;
        const restartCanStartNow = state.mode === "idle" || (state.mode === "paused" && !state.turnInFlight);
        if (explicitRestart && restartCanStartNow && !explicitRestartBudgetRead && typeof storage.getConversation === "function") {
            try {
                const conversationRow = await storage.getConversation(conversationId);
                explicitRestartBudgetRead = true;
                if (conversationRow) explicitRestartBudget = effectiveTurnBudget(conversationRow.turnBudget);
            } catch (error) {
                explicitRestartBudgetRead = true;
                console.error(`Orchestrator: Could not refresh turn budget for explicit restart of ${conversationId}; keeping the current budget:`, error);
            }
        }
        if (explicitRestart && restartCanStartNow && explicitRestartBudget !== undefined) {
            state = updateConversationState(conversationId, { maxAutonomousTurns: explicitRestartBudget });
        }
        const isActive = state.mode === "processing_sequential" || state.mode === "autonomous";

        // An explicit restart discards earlier joined context and counters.
        // Ordinary messages below join the active sequence in place.
        if (explicitRestart && (isActive || state.mode === "paused")) {
            updateConversationState(conversationId, {
                activeExperts,
                moderatorExpert,
                lastUserMessage: userMessage,
                sequenceFileCreatorRequest: isFileCreatorAllowed(userMessage.content) ? userMessage : null,
                pendingUserMessage: userMessage,
                pendingMentionRoutes: [],
                farmerJustSpoke: true,
                singleTurnOnly: false,
                wasInterrupted: true,
                ...resetStanceEvidence(userMessage, activeExperts),
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
            const sequenceFileCreatorRequest = nextSequenceFileCreatorRequest(state.sequenceFileCreatorRequest, userMessage);
            const newFarmerRoutes = mentionRoutesForMessage(userMessage.mentions, null, activeExperts);
            const existingFarmerRoutes = state.pendingMentionRoutes.filter(route => route.sourceRole === null);
            const existingExpertRoutes = state.pendingMentionRoutes.filter(route => route.sourceRole !== null);
            const pendingMentionRoutes = filterFileCreatorRoutes(
                [...existingFarmerRoutes, ...newFarmerRoutes, ...existingExpertRoutes],
                userMessage.content,
                Boolean(sequenceFileCreatorRequest),
            );
            const joined = updateConversationState(conversationId, {
                activeExperts,
                moderatorExpert,
                lastUserMessage: userMessage,
                sequenceFileCreatorRequest,
                pendingUserMessage: userMessage,
                pendingMentionRoutes,
                farmerJustSpoke: true,
                ...resetStanceEvidence(userMessage, activeExperts)
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
            sequenceFileCreatorRequest: isFileCreatorAllowed(userMessage.content) ? userMessage : null,
            pendingUserMessage: userMessage,
            pendingMentionRoutes: [],
            farmerJustSpoke: true,
            singleTurnOnly: false,
            wasInterrupted: false,
            ...resetStanceEvidence(userMessage, activeExperts),
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

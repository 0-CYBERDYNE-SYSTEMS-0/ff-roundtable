import { storage } from "./storage";
import { getExpertResponse, getExpertResponseStream, generateInsights, getModeratorNextSpeakerSuggestion } from "./ai";
import { shouldStopForRedundancy, REDUNDANCY_STOP_SIMILARITY_THRESHOLD } from "./text-similarity";
import type { InsertMessage, Expert, Message, File } from "@shared/schema";

// Verbose per-turn tracing is opt-in (ORCH_DEBUG=1). The default flood slows
// test teardown and leaks conversation content into production logs.
const ORCH_DEBUG = process.env.ORCH_DEBUG === "1";
const debugLog = (...args: unknown[]) => {
    if (ORCH_DEBUG) console.log(...args);
};

// Define interaction modes more formally
type InteractionMode = 
    | "idle"          // Not processing anything
    | "processing_sequential" // Actively processing turns triggered by user
    | "paused"        // User manually paused
    | "autonomous";   // Experts interacting autonomously (Future Step)

interface ConversationState {
    conversationId: number;
    activeExperts: Expert[];
    currentExpertIndex: number;
    lastUserMessage: Message | null; // Store the user message that triggered the sequence
    mode: InteractionMode;
    broadcastFn: (convId: number, data: any) => void; // Store broadcast function
    // Autonomous settings
    isAutonomousEnabled: boolean; // Default: true
    maxAutonomousTurns: number;   // Max turns per autonomous round (e.g., total expert responses)
    totalAutonomousTurnsTaken: number; // Counter for turns within the current autonomous session
    // Add a flag to indicate if the current sequence was interrupted by the user
    wasInterrupted: boolean;
    // Preserve the active phase while a sequence is paused.
    pausedFromMode: Exclude<InteractionMode, "idle" | "paused"> | null;
    // Internal (never broadcast): a turn is actively streaming right now.
    // pause() can land mid-turn; this is the only reliable "is a turn
    // actually streaming" signal for the paused-interrupt path.
    turnInFlight: boolean;
    // Internal (never broadcast): a processNextTurn chain is scheduled but
    // has not fired yet. Exactly one chain may drive a conversation at a
    // time — pause() followed immediately by resume() can otherwise leave
    // two setImmediate chains pending (one from the loop's own next-turn
    // scheduling, one from resume), double-driving turns and insights.
    turnChainScheduled: boolean;
    // In-memory recovery guard for a loop that died between turns.
    lastProgressAt: number;
    // Expert message contents of the CURRENT sequence (sequential round 1 +
    // autonomous extension). Used by the F2 redundancy early-stop; reset when
    // a new sequence starts, carried across the sequential→autonomous
    // transition.
    sequenceExpertContents: string[];
    // We might add turn limits, autonomous rounds etc. later
}

// Placeholder - In-memory state management 
const conversationStates: Map<number, ConversationState> = new Map();
const STALE_PROCESSING_MS = 5 * 60 * 1000;

function isUsableConversationState(state: ConversationState | undefined): state is ConversationState {
    return Boolean(
        state &&
        typeof state.broadcastFn === "function" &&
        Array.isArray(state.activeExperts) &&
        state.activeExperts.length > 0 &&
        Number.isInteger(state.currentExpertIndex) &&
        ["idle", "processing_sequential", "paused", "autonomous"].includes(state.mode) &&
        typeof state.lastProgressAt === "number" &&
        Array.isArray(state.sequenceExpertContents)
    );
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
    debugLog(`State updated for ${conversationId}: mode=${newState.mode}, expertIndex=${newState.currentExpertIndex}, autoTurns=${newState.totalAutonomousTurnsTaken}/${newState.maxAutonomousTurns}, interrupted=${newState.wasInterrupted}`);

    // Broadcast relevant state changes
    if (newState.mode !== previousState.mode || newState.isAutonomousEnabled !== previousState.isAutonomousEnabled) {
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
function initializeConversationState(conversationId: number, experts: Expert[], userMessage: Message, broadcastFn: (convId: number, data: any) => void): ConversationState {
    const defaultMaxAutonomousTurns = experts.length * 2; // Example: Allow 2 full rounds by default
    const initialState: ConversationState = {
        conversationId,
        activeExperts: experts,
        currentExpertIndex: -1, 
        lastUserMessage: userMessage,
        mode: "idle", 
        broadcastFn: broadcastFn,
        // Initialize autonomous settings
        isAutonomousEnabled: true, // Autonomous is ON by default
        maxAutonomousTurns: defaultMaxAutonomousTurns, 
        totalAutonomousTurnsTaken: 0,
        wasInterrupted: false, // Initialize interrupted flag
        pausedFromMode: null,
        turnInFlight: false,
        turnChainScheduled: false,
        lastProgressAt: Date.now(),
        sequenceExpertContents: []
    };
    conversationStates.set(conversationId, initialState);
    debugLog(`Initialized state for ${conversationId}, Auto ON (max ${defaultMaxAutonomousTurns} turns)`);
    // Broadcast initial state including autonomous info
    broadcastFn(conversationId, { 
        type: "state_update", 
        mode: "idle",
        isAutonomousEnabled: initialState.isAutonomousEnabled,
        maxAutonomousTurns: initialState.maxAutonomousTurns
    });
    return initialState;
}

function scheduleInterruptedMessage(state: ConversationState, pendingMessage: Message): void {
    const userId = pendingMessage.userId ?? 0;
    setImmediate(() => {
        processMessageTurnBased(userId, state.conversationId, pendingMessage, state.broadcastFn)
            .catch(error => {
                console.error(`Orchestrator: Failed to resume interrupted message for ${state.conversationId}:`, error);
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
        
        updateConversationState(this.conversationId, {
            mode: "processing_sequential",
            currentExpertIndex: -1,
            totalAutonomousTurnsTaken: 0, // Reset counter when new sequence starts
            wasInterrupted: false, // Reset interrupted flag
            pausedFromMode: null,
            sequenceExpertContents: [] // New sequence: redundancy history starts empty
        });

        debugLog(`Orchestrator starting processing sequence for conv ${this.conversationId}`);
        // Mark that exactly one turn chain is scheduled for this conversation.
        updateConversationState(this.conversationId, { turnChainScheduled: true });
        // Use setImmediate to avoid blocking the initial request and handle potential immediate pause
        setImmediate(() => {
            this.processNextTurn().catch(err => {
                console.error(`Orchestrator: Unhandled error starting processNextTurn for ${this.conversationId}:`, err);
                updateConversationState(this.conversationId, { mode: "idle" });
            });
        });
    }

    // Processes a single turn and triggers the next one if applicable
    private async processNextTurn(): Promise<void> {
        // Single-chain guard: claim the scheduled slot. Any second pending
        // chain (pause()+resume() racing the loop's own scheduling, a stale
        // chain from before an interrupted restart, ...) bows out here
        // instead of double-driving the loop.
        if (!getConversationState(this.conversationId)?.turnChainScheduled) {
            debugLog(`Orchestrator: duplicate turn chain for ${this.conversationId} bowing out.`);
            return;
        }
        updateConversationState(this.conversationId, { turnChainScheduled: false });

        let state = getConversationState(this.conversationId);
        // A turn is still streaming (resume() landing mid-turn schedules a
        // chain while the paused turn is in flight). The chain that owns the
        // in-flight turn continues the round from its own "Decide Next
        // Action" — starting a turn here would run two experts concurrently.
        if (state?.turnInFlight) {
            debugLog(`Orchestrator: turn still in flight for ${this.conversationId} — chain bowing out.`);
            return;
        }
        // Initial checks for stopping conditions
        if (!state || state.mode === "paused" || state.wasInterrupted) {
            const reason = !state ? "state missing" : state.mode === "paused" ? "paused" : "interrupted";
            debugLog(`Orchestrator stopping for ${this.conversationId}. Reason: ${reason}.`);
             if (state && state.wasInterrupted) {
                 // If interrupted, reset first, then immediately process the newest queued message.
                 const pendingMessage = state.lastUserMessage;
                 updateConversationState(this.conversationId, {
                     mode: "idle",
                     wasInterrupted: false,
                     currentExpertIndex: -1,
                     totalAutonomousTurnsTaken: 0,
                     pausedFromMode: null,
                     lastUserMessage: null
                 });
                 if (pendingMessage) {
                     scheduleInterruptedMessage(state, pendingMessage);
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
        if (state.mode === "autonomous" && !state.isAutonomousEnabled) {
            debugLog(`Orchestrator: autonomous disabled before turn start for ${this.conversationId} — ending sequence naturally.`);
            updateConversationState(this.conversationId, {
                mode: "idle",
                currentExpertIndex: -1,
                totalAutonomousTurnsTaken: 0,
                pausedFromMode: null
            });
            generateInsights(this.conversationId, state.broadcastFn).catch(console.error);
            return;
        }

        // 1. Determine the next expert index
        let nextExpertIndex = -1;
        // Set when the just-completed autonomous turn was redundant (F2) and
        // the sequence must stop early instead of scheduling another turn.
        let redundancyStopDetected = false;
        const availableRoles = state.activeExperts.map(e => e.role);

        if (state.mode === "autonomous") {
            const moderator = state.activeExperts.find(e => e.role === 'Moderator');
            let suggestedRole: string | null = null;
            if (moderator) {
                 const history = await storage.getConversationMessages(this.conversationId);
                 suggestedRole = await getModeratorNextSpeakerSuggestion(moderator, history.slice(-6), availableRoles);
            }
            if (suggestedRole && suggestedRole !== 'RoundRobin') {
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
        } else { // processing_sequential
            nextExpertIndex = state.currentExpertIndex + 1;
        }

        // 2. Check if processing should stop based on index or limits
        let endOfProcessing = false;
        if (state.mode === "processing_sequential" && nextExpertIndex >= state.activeExperts.length) {
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
            const currentExpert = state.activeExperts[nextExpertIndex]; // Guaranteed to exist now
            
            // --- Update State for the Current Turn --- 
            const turnsTakenUpdate = state.mode === "autonomous" 
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
            // If autonomous, always use the last expert's message from history
            else if (state.mode === "autonomous") { 
                const history = await storage.getConversationMessages(this.conversationId);
                // Find the last non-error assistant message
                const lastExpertMessage = history.slice().reverse().find(m => m.role === 'assistant' && !m.content.startsWith("(Error generating response"));
                if (!lastExpertMessage) {
                     // Should ideally not happen after sequential round, but handle defensively
                     console.error(`Orchestrator: Could not find previous expert message for autonomous turn ${state.totalAutonomousTurnsTaken}. Falling back to generic prompt.`);
                     referenceMessageContent = "Please continue the discussion based on the conversation history."; 
                } else {
                     referenceMessageContent = lastExpertMessage.content;
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
                
                // Broadcast "expert started typing"
                state.broadcastFn(this.conversationId, {
                    type: "expert_stream_start",
                    expertId: currentExpert.id,
                    expertName: currentExpert.name,
                    expertRole: currentExpert.role,
                });
                
                // Mark the turn as in-flight: pause()/steering can land while
                // this await is pending. Cleared in the finally below.
                updateConversationState(this.conversationId, { turnInFlight: true });
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
                // The current index/counter was advanced before the provider call.
                // Stop this sequence rather than silently continuing an incomplete turn.
                const failedState = getConversationState(this.conversationId);
                if (failedState) {
                    const pendingMessage = failedState.wasInterrupted ? failedState.lastUserMessage : null;
                    updateConversationState(this.conversationId, {
                        mode: "idle",
                        currentExpertIndex: -1,
                        totalAutonomousTurnsTaken: 0,
                        wasInterrupted: false,
                        pausedFromMode: null,
                        lastUserMessage: pendingMessage ? null : failedState.lastUserMessage
                    });
                    if (pendingMessage) {
                        scheduleInterruptedMessage(failedState, pendingMessage);
                    }
                }
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
            if (currentState.isAutonomousEnabled && currentState.maxAutonomousTurns > 0) {
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
             // Check limits *before* deciding to continue
             // G2: autonomous disabled mid-round ends the sequence with the
             // same cleanup as a natural end (idle + insights). The current
             // expert's turn always finishes; disableAutonomous() never pauses.
             if (!currentState.isAutonomousEnabled) {
                 debugLog("Autonomous disabled mid-round — ending sequence naturally.");
                 processingEndedNaturally = true;
             }
             // F2: a redundant autonomous answer ends the sequence with the
             // same cleanup as a natural end (idle + insights). An interrupt
             // arriving during the turn wins — the queued message restarts.
             else if (redundancyStopDetected && !currentState.wasInterrupted) {
                 debugLog("Orchestrator: Autonomous sequence stopped early (redundant answer). Setting mode to idle.");
                 processingEndedNaturally = true;
             } else if (currentState.totalAutonomousTurnsTaken >= currentState.maxAutonomousTurns) {
                 debugLog("Orchestrator: Reached max autonomous turns. Setting mode to idle."); // KEEP
                 processingEndedNaturally = true; 
                  debugLog("[DEBUG] Set processingEndedNaturally = true (Auto Limit Reached)");
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
             updateConversationState(this.conversationId, { mode: "idle", currentExpertIndex: -1, totalAutonomousTurnsTaken: 0, pausedFromMode: null });
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
                     console.error(`Orchestrator: Unhandled error in processNextTurn recursion for ${this.conversationId}:`, err);
                     updateConversationState(this.conversationId, { mode: "idle" });
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
                      lastUserMessage: null
                  });
                  if (pendingMessage) {
                      scheduleInterruptedMessage(finalStateCheck, pendingMessage);
                  }
                  return;
             }
             // If we aren't continuing and weren't paused/interrupted, ensure state is idle
             if (finalStateCheck && finalStateCheck.mode !== 'paused' && !finalStateCheck.wasInterrupted && !continueProcessing) {
                  debugLog("[DEBUG] Setting state to idle because not continuing and not paused/interrupted.");
                  updateConversationState(this.conversationId, { mode: "idle" });
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
            const resumeToMode = state.pausedFromMode ||
                (state.totalAutonomousTurnsTaken > 0 ? "autonomous" : "processing_sequential");
                                
            updateConversationState(this.conversationId, { mode: resumeToMode, pausedFromMode: null, turnChainScheduled: true });

            // Trigger the next turn processing immediately
            setImmediate(() => {
                this.processNextTurn().catch(err => {
                    console.error(`Orchestrator: Unhandled error resuming processNextTurn for ${this.conversationId}:`, err);
                    updateConversationState(this.conversationId, { mode: "idle" });
                });
           });
        } else {
             debugLog(`Orchestrator: Cannot resume conversation ${this.conversationId}. Current mode: ${state?.mode}`);
        }
    }

    // --- Autonomous Control Methods ---
    enableAutonomous(maxTurns?: number): void {
        const state = getConversationState(this.conversationId);
        if (!state) return;

        const newMaxTurns = (typeof maxTurns === 'number' && maxTurns >= 0) 
            ? maxTurns 
            : state.activeExperts.length * 2; // Default if not provided or invalid

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
    broadcastFn: (convId: number, data: any) => void
): Promise<void> {
    try {
        // Get current state and experts
        let state = getConversationState(conversationId);
        const experts = await storage.getConversationExperts(conversationId);
        if (!experts || experts.length === 0) {
            debugLog(`No experts assigned to conversation ${conversationId}. Cannot process message.`);
            return;
        }

        const stateIsStale = state &&
            ((state.mode === "processing_sequential" || state.mode === "autonomous") &&
                (!isUsableConversationState(state) || Date.now() - state.lastProgressAt > STALE_PROCESSING_MS));

        if (!isUsableConversationState(state) || stateIsStale) {
            if (state) {
                console.warn(`Recovering stale or partial orchestrator state for conversation ${conversationId}.`);
            }
            // Initialize if first message for this server instance, or recover
            // from a state left behind by a crashed loop.
            state = initializeConversationState(conversationId, experts, userMessage, broadcastFn);
        } else {
            // State exists, check for interruption
            const isBusy = state.mode === "processing_sequential" || state.mode === "autonomous";
            if (isBusy) {
                 debugLog(`User message arrived during active sequence (mode: ${state.mode}). Interrupting.`);
                  // Set interrupted flag and update context. The running loop will
                  // finish its current expert and immediately restart this message.
                 updateConversationState(conversationId, { 
                     wasInterrupted: true,
                     activeExperts: experts, // Update experts list potentially
                     lastUserMessage: userMessage // Store newest user message
                 });
                 // Tell the client its message was accepted as steering: the
                 // current expert finishes, then the round restarts on it.
                 broadcastFn(conversationId, { type: "steering" });
                 return;
            } else {
                // If not busy (idle or paused), just update state normally
                 updateConversationState(conversationId, { 
                    activeExperts: experts, 
                    lastUserMessage: userMessage, 
                    wasInterrupted: false // Ensure flag is clear if we were idle/paused
                });
                state = getConversationState(conversationId)!; // Re-fetch state

                // A message while paused is an implicit resume-and-restart: a
                // parked conversation comes back to life the moment the farmer
                // speaks. The user message itself was already persisted by
                // routes.ts before this call.
                if (state.mode === "paused") {
                    if (state.turnInFlight) {
                        // A turn is still streaming. Flag the interrupt; the
                        // running loop's final check resets to idle and
                        // re-processes this message once the turn finishes.
                        updateConversationState(conversationId, { wasInterrupted: true });
                        debugLog(`Message arrived while paused mid-turn for ${conversationId}. Interrupting after the current expert.`);
                    } else {
                        // Parked between turns: reset and restart immediately
                        // on the new message.
                        updateConversationState(conversationId, {
                            mode: "idle",
                            wasInterrupted: false,
                            currentExpertIndex: -1,
                            totalAutonomousTurnsTaken: 0,
                            pausedFromMode: null,
                            lastUserMessage: null
                        });
                        debugLog(`Message arrived while paused for ${conversationId}. Restarting sequence on the new message.`);
                        scheduleInterruptedMessage(state, userMessage);
                    }
                    return; // Never fall through to the idle start below.
                }
            }
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
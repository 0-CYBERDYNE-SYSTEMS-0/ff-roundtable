import { storage } from "./storage";
import { getExpertResponse, generateInsights, getModeratorNextSpeakerSuggestion } from "./ai";
import type { InsertMessage, Expert, Message, File } from "@shared/schema";

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
    // We might add turn limits, autonomous rounds etc. later
}

// Placeholder - In-memory state management 
const conversationStates: Map<number, ConversationState> = new Map();

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
    const newState = { ...existingState, ...updates };
    conversationStates.set(conversationId, newState);
    console.log(`State updated for ${conversationId}: mode=${newState.mode}, expertIndex=${newState.currentExpertIndex}, autoTurns=${newState.totalAutonomousTurnsTaken}/${newState.maxAutonomousTurns}, interrupted=${newState.wasInterrupted}`);

    // Broadcast relevant state changes
    if (newState.mode !== previousState.mode || newState.isAutonomousEnabled !== previousState.isAutonomousEnabled) {
        existingState.broadcastFn(conversationId, { 
            type: "state_update", 
            mode: newState.mode, 
            isAutonomousEnabled: newState.isAutonomousEnabled,
            maxAutonomousTurns: newState.maxAutonomousTurns
        });
        console.log(`Broadcasted state update for ${conversationId}: mode=${newState.mode}, autoEnabled=${newState.isAutonomousEnabled}`);
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
        wasInterrupted: false // Initialize interrupted flag
    };
    conversationStates.set(conversationId, initialState);
    console.log(`Initialized state for ${conversationId}, Auto ON (max ${defaultMaxAutonomousTurns} turns)`);
    // Broadcast initial state including autonomous info
    broadcastFn(conversationId, { 
        type: "state_update", 
        mode: "idle",
        isAutonomousEnabled: initialState.isAutonomousEnabled,
        maxAutonomousTurns: initialState.maxAutonomousTurns
    });
    return initialState;
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
            wasInterrupted: false // Reset interrupted flag
        });

        console.log(`Orchestrator starting processing sequence for conv ${this.conversationId}`);
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
        let state = getConversationState(this.conversationId);
        // Initial checks for stopping conditions
        if (!state || state.mode === "paused" || state.wasInterrupted) {
            const reason = !state ? "state missing" : state.mode === "paused" ? "paused" : "interrupted";
            console.log(`Orchestrator stopping for ${this.conversationId}. Reason: ${reason}.`);
             if (state && state.wasInterrupted) {
                 // If interrupted, ensure state becomes idle and clear the flag before stopping
                 updateConversationState(this.conversationId, { mode: "idle", wasInterrupted: false, currentExpertIndex: -1, totalAutonomousTurnsTaken: 0 });
             }
            return; 
        }
        if (state.mode !== "processing_sequential" && state.mode !== "autonomous") {
            console.log(`Orchestrator stopping for ${this.conversationId}. Unexpected Mode: ${state.mode}`);
            return;
        }

        // 1. Determine the next expert index
        let nextExpertIndex = -1;
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
            console.log("End of sequential round detected.");
            endOfProcessing = true; // Will decide transition/stop later
            nextExpertIndex = -1; // Signal end of round
        } else if (state.mode === "autonomous" && state.totalAutonomousTurnsTaken >= state.maxAutonomousTurns) {
            console.log(`Reached max autonomous turns (${state.maxAutonomousTurns}).`);
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
            
            console.log(`Orchestrator turn: Expert ${currentExpert.name} (Index: ${nextExpertIndex}, Mode: ${state.mode}, Auto Turn: ${state.totalAutonomousTurnsTaken}/${state.maxAutonomousTurns})`);

            // --- Call Expert --- 
            try {
                const history = await storage.getConversationMessages(this.conversationId);
                const files = await storage.getConversationFiles(this.conversationId);
                const expertResponse: InsertMessage = await getExpertResponse(
                    currentExpert, history, referenceMessageContent, files, availableRoles 
                ); 
                const storedExpertMessage = await storage.createMessage(expertResponse);
                state.broadcastFn(this.conversationId, storedExpertMessage);
                console.log(`Orchestrator broadcasted response from ${currentExpert.name}`);
            } catch (error) {
                 console.error(`Orchestrator: Error processing expert ${currentExpert.name}:`, error);
                 state.broadcastFn(this.conversationId, {
                    type: "message_error", expertId: currentExpert.id,
                    expertName: currentExpert.name, message: `Error getting response from ${currentExpert.name}.`
                });
            }
        } // End if(nextExpertIndex !== -1)

        // 4. Decide Next Action (Schedule next turn or transition/stop)
        console.log(`[DEBUG] Decide Next Action for ${this.conversationId} | Current Mode: ${state.mode} | Last Expert Index: ${state.currentExpertIndex} | Next Calculated Index: ${nextExpertIndex} | Auto Turns: ${state.totalAutonomousTurnsTaken}/${state.maxAutonomousTurns}`);
        const currentState = getConversationState(this.conversationId);
        if (!currentState) {
             console.error(`[DEBUG] State missing in Decide Next Action for ${this.conversationId}. Aborting.`);
             return; 
        }

        let continueProcessing = false;
        let processingEndedNaturally = false; // Use a flag to signal natural stop vs. transition
        const wasEndOfSequentialRound = currentState.mode === "processing_sequential" && nextExpertIndex === -1;
        console.log(`[DEBUG] wasEndOfSequentialRound = ${wasEndOfSequentialRound}`);
        
        if (wasEndOfSequentialRound) {
            console.log(`[DEBUG] Checking condition: isAutonomousEnabled=${currentState.isAutonomousEnabled}, maxAutonomousTurns=${currentState.maxAutonomousTurns}`);
            if (currentState.isAutonomousEnabled && currentState.maxAutonomousTurns > 0) {
                console.log("Orchestrator: Sequential round finished. Switching to Autonomous mode."); // KEEP
                updateConversationState(this.conversationId, { 
                    mode: "autonomous", currentExpertIndex: -1, 
                    totalAutonomousTurnsTaken: 0, lastUserMessage: null 
                }); 
                continueProcessing = true;
                console.log("[DEBUG] Set continueProcessing = true (Transitioning to Auto)");
            } else {
                console.log("Orchestrator: Sequential round finished. Autonomous disabled. Setting to idle."); // KEEP
                processingEndedNaturally = true; 
                 console.log("[DEBUG] Set processingEndedNaturally = true (Auto Disabled/Limit 0)");
            }
        } else if (currentState.mode === "autonomous") {
             console.log("[DEBUG] Currently in Autonomous mode. Checking limits...");
             // Check limits *before* deciding to continue
             if (currentState.totalAutonomousTurnsTaken >= currentState.maxAutonomousTurns) {
                 console.log("Orchestrator: Reached max autonomous turns. Setting mode to idle."); // KEEP
                 processingEndedNaturally = true; 
                  console.log("[DEBUG] Set processingEndedNaturally = true (Auto Limit Reached)");
             } else {
                 continueProcessing = true; // Continue autonomous processing
                 console.log("[DEBUG] Set continueProcessing = true (Continuing Auto)");
             }
        } else if (currentState.mode === "processing_sequential" && nextExpertIndex !== -1) {
             // Continue sequential if we processed a turn and it wasn't the end signal
             continueProcessing = true;
             console.log("[DEBUG] Set continueProcessing = true (Continuing Sequential)");
        }

        // Final actions if processing ended naturally
        if (processingEndedNaturally) {
             console.log("[DEBUG] Processing ended naturally. Updating state to idle and generating insights.");
             updateConversationState(this.conversationId, { mode: "idle", currentExpertIndex: -1, totalAutonomousTurnsTaken: 0 });
             generateInsights(this.conversationId, state.broadcastFn).catch(console.error);
             continueProcessing = false; // Ensure we don't schedule next turn
        }
        
        // Schedule next turn if decided and not paused/interrupted
        // Re-fetch state one last time before scheduling to ensure mode wasn't changed by pause/interrupt
        const finalStateCheck = getConversationState(this.conversationId);
         console.log(`[DEBUG] Final check before scheduling: continueProcessing=${continueProcessing}, finalMode=${finalStateCheck?.mode}, finalInterrupted=${finalStateCheck?.wasInterrupted}`);
        if (continueProcessing && finalStateCheck && finalStateCheck.mode !== "paused" && !finalStateCheck.wasInterrupted) {
            console.log("[DEBUG] Scheduling next turn via setImmediate.");
            setImmediate(() => {
                 this.processNextTurn().catch(err => {
                     console.error(`Orchestrator: Unhandled error in processNextTurn recursion for ${this.conversationId}:`, err);
                     updateConversationState(this.conversationId, { mode: "idle" });
                 });
            });
        } else {
             // Use the already fetched finalStateCheck here
             console.log(`Orchestrator: Not scheduling next turn for ${this.conversationId}. Final State Mode: ${finalStateCheck?.mode}, Continue: ${continueProcessing}, Interrupted: ${finalStateCheck?.wasInterrupted}.`); // KEEP
             // If we aren't continuing and weren't paused/interrupted, ensure state is idle
             if (finalStateCheck && finalStateCheck.mode !== 'paused' && !finalStateCheck.wasInterrupted && !continueProcessing) {
                  console.log("[DEBUG] Setting state to idle because not continuing and not paused/interrupted.");
                  updateConversationState(this.conversationId, { mode: "idle" });
             }
        }
    }

    // --- Control Methods ---
    pause(): void {
        const state = getConversationState(this.conversationId);
        if (state && (state.mode === "processing_sequential" || state.mode === "autonomous")) {
            console.log(`Orchestrator pausing conversation ${this.conversationId}`);
            updateConversationState(this.conversationId, { mode: "paused" });
        } else {
             console.log(`Orchestrator: Cannot pause conversation ${this.conversationId}. Current mode: ${state?.mode}`);
        }
    }

    resume(): void {
        const state = getConversationState(this.conversationId);
        if (state && state.mode === "paused") {
            console.log(`Orchestrator resuming conversation ${this.conversationId}`);
            // Determine which mode to resume to 
            // If auto is enabled AND we haven't hit limits, resume to autonomous
            const resumeToMode = (state.isAutonomousEnabled && state.totalAutonomousTurnsTaken < state.maxAutonomousTurns) 
                                ? "autonomous" 
                                : "processing_sequential"; // TODO: Revisit this logic - might need more nuance
                                
            updateConversationState(this.conversationId, { mode: resumeToMode });
            
            // Trigger the next turn processing immediately
            setImmediate(() => {
                this.processNextTurn().catch(err => {
                    console.error(`Orchestrator: Unhandled error resuming processNextTurn for ${this.conversationId}:`, err);
                    updateConversationState(this.conversationId, { mode: "idle" });
                });
           });
        } else {
             console.log(`Orchestrator: Cannot resume conversation ${this.conversationId}. Current mode: ${state?.mode}`);
        }
    }

    // --- Autonomous Control Methods ---
    enableAutonomous(maxTurns?: number): void {
        const state = getConversationState(this.conversationId);
        if (!state) return;

        const newMaxTurns = (typeof maxTurns === 'number' && maxTurns >= 0) 
            ? maxTurns 
            : state.activeExperts.length * 2; // Default if not provided or invalid

        console.log(`Orchestrator enabling autonomous mode for ${this.conversationId} (max ${newMaxTurns} turns)`);
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
        
        console.log(`Orchestrator disabling autonomous mode for ${this.conversationId}`);
        updateConversationState(this.conversationId, { 
            isAutonomousEnabled: false,
            // Optionally reset maxAutonomousTurns to 0 or keep the value?
            // maxAutonomousTurns: 0 
        });
        // If currently in autonomous mode, pausing might be safer than directly setting to idle
        if (state.mode === "autonomous") {
             console.log("Currently in autonomous mode, pausing processing.");
             this.pause();
        }
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
            console.log(`No experts assigned to conversation ${conversationId}. Cannot process message.`);
            return;
        }

        if (!state) {
            // Initialize if first message for this server instance
            state = initializeConversationState(conversationId, experts, userMessage, broadcastFn);
        } else {
            // State exists, check for interruption
            const isBusy = state.mode === "processing_sequential" || state.mode === "autonomous";
            if (isBusy) {
                 console.log(`User message arrived during active sequence (mode: ${state.mode}). Interrupting.`);
                 // Set interrupted flag and update context. DO NOT change mode here.
                 // The running processNextTurn loop will detect the flag and stop itself, setting mode to idle.
                 updateConversationState(conversationId, { 
                     wasInterrupted: true,
                     activeExperts: experts, // Update experts list potentially
                     lastUserMessage: userMessage // Store newest user message
                 });
                 // *** Do not force state to idle here ***
                 // Let the current turn finish and handle the interruption flag.
                 return; // Stop further processing for *this* user message event
            } else {
                // If not busy (idle or paused), just update state normally
                 updateConversationState(conversationId, { 
                    activeExperts: experts, 
                    lastUserMessage: userMessage, 
                    wasInterrupted: false // Ensure flag is clear if we were idle/paused
                });
                state = getConversationState(conversationId)!; // Re-fetch state
            }
        }

        // Only start processing if the orchestrator is currently idle
        // This will now be triggered by the *next* user message after an interruption clears
        if (state.mode === "idle") {
            const orchestrator = new InteractionOrchestrator(conversationId);
            await orchestrator.startProcessingSequence(); 
        } else {
            // This can happen if the state was paused when the message arrived
            console.log(`Orchestrator for ${conversationId} is not idle (mode: ${state.mode}). New message queued in state.`);
        }

    } catch (error) {
        console.error(`Error in processMessageTurnBased for conversation ${conversationId}:`, error);
        broadcastFn(conversationId, { type: "error", message: "Failed to process message." });
    }
} 
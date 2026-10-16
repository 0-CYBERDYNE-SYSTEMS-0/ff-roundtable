/**
 * Expert deliverables are parsed during the model call but saved only after
 * the orchestrator accepts the turn (a near-duplicate turn is discarded and
 * must not leave a document behind). Kept separate from ai.ts so modules that
 * mock ai.ts still get the real commit/discard functions.
 */
import type { Expert, InsertMessage } from "@shared/schema";
import { storage } from "./storage";
import { saveExpertDeliverable, type ParsedDeliverable, type RevisionContext } from "./expert-tools";

export const DELIVERABLE_PLACEHOLDER = "{{deliverable}}";
export const pendingDeliverableFor = new WeakMap<object, ParsedDeliverable>();
export const pendingDeliverableByMessage = new WeakMap<object, { expert: Expert; deliverable: ParsedDeliverable }>();

export async function commitPendingDeliverable(message: InsertMessage, context: RevisionContext = {}): Promise<void> {
  const pending = pendingDeliverableByMessage.get(message);
  if (!pending) return;
  pendingDeliverableByMessage.delete(message);
  const { expert, deliverable } = pending;
  let line: string;
  try {
    const saved = await saveExpertDeliverable(storage as any, expert.conversationId, expert, deliverable, undefined, context);
    line = saved.proposalFor
      ? `Proposed changes to **${saved.proposalFor.title}** (owned by ${saved.proposalFor.owner}) saved as **${saved.title}** (v${saved.version}). The owner or the farmer can adopt them.`
      : `${saved.revised ? "Updated" : "Created"} deliverable **${saved.title}** (v${saved.version}) — open it in the Files tab.`;
  } catch (error) {
    console.warn(`[TOOLS] deliverable save failed for ${expert.role}: ${(error as Error).message}`);
    line = "(The document could not be saved this time.)";
  }
  message.content = message.content.replace(DELIVERABLE_PLACEHOLDER, line);
}

export function discardPendingDeliverable(message: InsertMessage): void {
  const pending = pendingDeliverableByMessage.get(message);
  pendingDeliverableByMessage.delete(message);
  if (pending) console.log(`[TOOLS] discarded unsaved deliverable "${pending.deliverable.title}" from ${pending.expert.role}`);
}

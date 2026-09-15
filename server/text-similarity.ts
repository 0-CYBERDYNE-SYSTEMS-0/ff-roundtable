/**
 * Pure text-similarity + token-cost decision helpers (SPEC_DOGFOOD_GAP_REMEDIATION.md §F2).
 *
 * No I/O, no server dependencies — everything here is unit-testable in isolation.
 */

/**
 * Normalize text into lowercase word tokens. Punctuation is treated as a
 * separator so "Great point!" and "great point" tokenize identically.
 */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Word-trigram set of a text. Inputs shorter than 3 words fall back to their
 * word set (unigrams) so short messages still compare meaningfully.
 */
export function wordTrigrams(text: string): Set<string> {
  const words = normalizeWords(text);
  if (words.length < 3) return new Set(words);
  const grams = new Set<string>();
  for (let i = 0; i <= words.length - 3; i++) {
    grams.add(words.slice(i, i + 3).join(" "));
  }
  return grams;
}

/**
 * Jaccard similarity of the word-trigram sets of two texts, in [0, 1].
 * Two empty tokenizations compare via their joined words (identical → 1,
 * otherwise 0); exactly one empty → 0.
 */
export function trigramJaccard(a: string, b: string): number {
  const ga = wordTrigrams(a);
  const gb = wordTrigrams(b);
  if (ga.size === 0 && gb.size === 0) {
    return normalizeWords(a).join(" ") === normalizeWords(b).join(" ") ? 1 : 0;
  }
  if (ga.size === 0 || gb.size === 0) return 0;
  let intersection = 0;
  // Set#forEach instead of for..of: tsconfig has no target/downlevelIteration.
  ga.forEach((gram) => {
    if (gb.has(gram)) intersection++;
  });
  return intersection / (ga.size + gb.size - intersection);
}

/**
 * Autonomous turns whose new message exceeds this similarity against any prior
 * expert message are treated as redundant and stop the sequence early.
 * Conservative on purpose: prefer burning one extra turn over cutting a
 * legitimately new contribution.
 */
export const REDUNDANCY_STOP_SIMILARITY_THRESHOLD = 0.8;

export interface RedundancyDecision {
  stop: boolean;
  maxSimilarity: number;
  /** Index into priorMessages of the most similar prior message (-1 if none). */
  matchedIndex: number;
}

/**
 * Stop decision for the autonomous loop: true when newMessage's trigram
 * Jaccard similarity exceeds `threshold` against ANY prior expert message.
 * Pure — the orchestrator owns all state and cleanup.
 */
export function shouldStopForRedundancy(
  newMessage: string,
  priorMessages: string[],
  threshold: number = REDUNDANCY_STOP_SIMILARITY_THRESHOLD
): RedundancyDecision {
  let maxSimilarity = 0;
  let matchedIndex = -1;
  priorMessages.forEach((prior, i) => {
    const similarity = trigramJaccard(newMessage, prior);
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      matchedIndex = i;
    }
  });
  return { stop: maxSimilarity > threshold, maxSimilarity, matchedIndex };
}

/**
 * Duplicate-submission gate for POST /messages: an incoming submission is a
 * no-op duplicate only when it is byte-identical (after trim) to the
 * conversation's current last message, that last message is from the user,
 * and no new files accompany it. Anything else processes normally.
 */
export function isDuplicateUserSubmission(
  incomingContent: string | null | undefined,
  lastMessage: { content: string; role: string } | null | undefined,
  hasNewFiles: boolean
): boolean {
  if (!incomingContent || !lastMessage) return false;
  if (hasNewFiles) return false;
  if (lastMessage.role !== "user") return false;
  return incomingContent.trim() === lastMessage.content.trim();
}

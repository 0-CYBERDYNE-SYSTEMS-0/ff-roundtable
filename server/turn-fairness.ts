/**
 * Turn-taking rules applied after the Moderator / mention queue proposes a
 * speaker. Live bug (2026-10-16): with [Soil, Irrigation, Pest] and a farmer
 * @Pest, Pest answered three times in a row and Irrigation never spoke.
 *
 * Rules, in order:
 *  (a) a farmer @mention is honoured once per farmer message;
 *  (b) while some healthy expert has not spoken since the farmer's message,
 *      anyone who already spoke yields to the first unspoken (roster order);
 *  (c) nobody speaks twice in a row if another healthy expert is available;
 *  (d) per-expert cap per sequence: ceil(budget / roster) + 1.
 */
export const MAX_CONSECUTIVE_TURNS = 1;

export interface FairnessInput {
  rosterIds: number[];
  /** Experts that failed or were retired for this sequence (e.g. duplicate answer). */
  excludedIds: number[];
  /** Expert ids of messages since the latest farmer message, oldest first. */
  speakersSinceFarmer: number[];
  candidateId: number | null;
  isFarmerMentionRoute: boolean;
  turnBudget?: number;
}

export function perExpertTurnCap(rosterSize: number, turnBudget = 8): number {
  return Math.ceil(turnBudget / Math.max(1, rosterSize)) + 1;
}

/** Returns the expert id that should speak, or null when nobody may. */
export function enforceTurnFairness(input: FairnessInput): number | null {
  const healthy = input.rosterIds.filter(id => !input.excludedIds.includes(id));
  if (healthy.length === 0) return null;
  const counts = new Map<number, number>();
  for (const id of input.speakersSinceFarmer) counts.set(id, (counts.get(id) ?? 0) + 1);
  const last = input.speakersSinceFarmer[input.speakersSinceFarmer.length - 1];
  const cap = perExpertTurnCap(healthy.length, input.turnBudget);
  const unspoken = healthy.filter(id => !counts.has(id));
  const candidate = input.candidateId !== null && healthy.includes(input.candidateId) ? input.candidateId : null;

  // (a) first answer to a farmer mention
  if (candidate !== null && input.isFarmerMentionRoute && !counts.has(candidate)) return candidate;
  // (b) everyone gets a turn before anyone speaks again
  if (unspoken.length > 0) {
    return candidate !== null && unspoken.includes(candidate) ? candidate : unspoken[0];
  }
  // (c) + (d)
  const eligible = healthy.filter(id => (counts.get(id) ?? 0) < cap && !(healthy.length > 1 && id === last));
  if (eligible.length === 0) return null;
  if (candidate !== null && eligible.includes(candidate)) return candidate;
  // least-heard first, roster order breaks ties
  return eligible.slice().sort((a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0) || healthy.indexOf(a) - healthy.indexOf(b))[0];
}

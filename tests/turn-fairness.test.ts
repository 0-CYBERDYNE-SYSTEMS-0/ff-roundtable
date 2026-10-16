import { describe, expect, it } from "vitest";
import { enforceTurnFairness, perExpertTurnCap } from "../server/turn-fairness";

const SOIL = 1, IRR = 2, PEST = 3;
const roster = [SOIL, IRR, PEST];
const pick = (speakers: number[], candidateId: number | null, isFarmerMentionRoute = false, excludedIds: number[] = []) =>
  enforceTurnFairness({ rosterIds: roster, excludedIds, speakersSinceFarmer: speakers, candidateId, isFarmerMentionRoute });

describe("turn fairness", () => {
  it("live repro: farmer @Pest -> Pest, then Soil and Irrigation before Pest again", () => {
    const order: number[] = [];
    // The Moderator keeps proposing Pest every turn (the observed bug).
    for (let turn = 0; turn < 4; turn++) order.push(pick(order, PEST, turn === 0)!);
    expect(order.slice(0, 3)).toEqual([PEST, SOIL, IRR]);
    expect(new Set(order.slice(0, 3)).size).toBe(3);
    expect(order[3]).toBe(PEST); // allowed only after everyone spoke, and not consecutive
  });
  it("(a) a farmer mention is honoured once", () => {
    expect(pick([], IRR, true)).toBe(IRR);
    expect(pick([IRR], IRR, true)).toBe(SOIL);
  });
  it("(c) never twice in a row when someone else can speak", () => {
    expect(pick([SOIL, IRR, PEST], PEST)).not.toBe(PEST);
  });
  it("(d) per-expert cap ends the sequence", () => {
    const cap = perExpertTurnCap(3, 3); // 2
    const full = [SOIL, IRR, PEST, SOIL, IRR, PEST];
    expect(cap).toBe(2);
    expect(enforceTurnFairness({ rosterIds: roster, excludedIds: [], speakersSinceFarmer: full, candidateId: SOIL, isFarmerMentionRoute: false, turnBudget: 3 })).toBeNull();
  });
  it("skips excluded (failed / duplicate) experts", () => {
    expect(pick([PEST], PEST, false, [SOIL])).toBe(IRR);
    expect(pick([], null, false, roster)).toBeNull();
  });
  it("single-expert roster may continue", () => {
    expect(enforceTurnFairness({ rosterIds: [SOIL], excludedIds: [], speakersSinceFarmer: [SOIL], candidateId: SOIL, isFarmerMentionRoute: false })).toBe(SOIL);
  });
});

import { isNearDuplicate } from "../server/text-similarity";
describe("isNearDuplicate", () => {
  const a = "The V-shaped yellowing of lower leaves after a wet June is most consistent with nitrogen loss from denitrification in heavy clay; scout for disease first.";
  it("flags a reworded repeat, passes new content", () => {
    expect(isNearDuplicate(a.replace("most consistent", "most likely consistent"), [a])).toBe(true);
    expect(isNearDuplicate("Tile drainage maps show ponding in the north quarter; a split application of 30 lb N with an inhibitor reduces further loss.", [a])).toBe(false);
  });
});

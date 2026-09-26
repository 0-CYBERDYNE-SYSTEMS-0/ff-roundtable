/**
 * G4 Mention extraction unit tests
 *
 * extractMentions is the single parser shared by server (persistence +
 * routing) and, later, client (rendering). These tests pin its contract:
 *  - canonical bracketed form (case-insensitive, whitespace-tolerant)
 *  - tolerated bare form with prefix matching (longest match wins)
 *  - order of first appearance, deduped, filtered to the roster
 *  - edge cases: '@' at end, unknown roles, empty roster, emails
 */

import { describe, it, expect } from "vitest";
import { extractMentions } from "../shared/mentions";

const ROSTER = ["Soil Scientist", "Crop Specialist", "Meteorologist", "Irrigation Engineer"];

describe("extractMentions", () => {
  // ── Canonical bracketed form ──────────────────────────────────────────

  it("matches an exact bracketed mention", () => {
    expect(extractMentions("Hey @[Soil Scientist], what about our pH?", ROSTER)).toEqual([
      "Soil Scientist",
    ]);
  });

  it("matches bracketed mentions case-insensitively", () => {
    expect(extractMentions("@[soil scientist] and @[METEOROLOGIST]", ROSTER)).toEqual([
      "Soil Scientist",
      "Meteorologist",
    ]);
  });

  it("tolerates extra whitespace inside the brackets", () => {
    expect(extractMentions("@[  Soil   Scientist ] please advise", ROSTER)).toEqual([
      "Soil Scientist",
    ]);
  });

  it("filters out unknown bracketed roles", () => {
    expect(extractMentions("@[Unknown Role] and @[Soil Scientist]", ROSTER)).toEqual([
      "Soil Scientist",
    ]);
  });

  it("returns [] for an unterminated bracket", () => {
    expect(extractMentions("what about @[Soil Scientist", ROSTER)).toEqual([]);
  });

  // ── Bare form (prefix matching) ───────────────────────────────────────

  it("prefix-matches a bare single-word tag", () => {
    expect(extractMentions("@soil what do you think?", ROSTER)).toEqual(["Soil Scientist"]);
  });

  it("prefix-matches a bare multi-word tag", () => {
    expect(extractMentions("asking @crop spec for variety advice", ROSTER)).toEqual([
      "Crop Specialist",
    ]);
  });

  it("matches a bare full role name exactly", () => {
    expect(extractMentions("@meteorologist, is rain coming?", ROSTER)).toEqual(["Meteorologist"]);
  });

  it("prefix-matches even when trailing prose follows the role", () => {
    // The bare run is "soil scientist and then some" — word-prefix matching
    // still resolves the first two words to the role.
    expect(extractMentions("@soil scientist and then tell us more", ROSTER)).toEqual([
      "Soil Scientist",
    ]);
  });

  it("prefers the longest role when two roles share the typed prefix", () => {
    expect(extractMentions("@crop", ["Crop Advisor", "Crop Specialist"])).toEqual([
      "Crop Specialist",
    ]);
  });

  it("resolves an exact bare role name even when it prefixes another role", () => {
    expect(extractMentions("@soil", ["Soil Scientist", "Soil", "Meteorologist"])).toEqual([
      "Soil",
    ]);
  });

  it("prefers an exact match over a longer role sharing it as a prefix", () => {
    expect(extractMentions("@soil scientist", ["Soil Scientist", "Soil Scientist Junior"])).toEqual([
      "Soil Scientist",
    ]);
  });

  // ── Order, dedupe, mixing forms ───────────────────────────────────────

  it("returns roles in order of first appearance, deduped across forms", () => {
    const content = "@[Meteorologist] first, then @soil, again @[Soil Scientist], and @[Meteorologist]";
    expect(extractMentions(content, ROSTER)).toEqual(["Meteorologist", "Soil Scientist"]);
  });

  it("handles multiple distinct tags in one message", () => {
    const content = "@[Crop Specialist] compare notes with @[Irrigation Engineer] please";
    expect(extractMentions(content, ROSTER)).toEqual(["Crop Specialist", "Irrigation Engineer"]);
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it("returns [] for an empty roster", () => {
    expect(extractMentions("@[Soil Scientist] @soil", [])).toEqual([]);
  });

  it("returns [] for empty content", () => {
    expect(extractMentions("", ROSTER)).toEqual([]);
  });

  it("returns [] for a trailing '@'", () => {
    expect(extractMentions("what about watering @", ROSTER)).toEqual([]);
  });

  it("returns [] for a lone '@' and an empty bracket", () => {
    expect(extractMentions("@ and @[]", ROSTER)).toEqual([]);
  });

  it("returns [] for '@' followed by a space (not a role run)", () => {
    expect(extractMentions("let's meet @ noon", ROSTER)).toEqual([]);
  });

  it("does not treat emails as mentions", () => {
    expect(extractMentions("email me at farmer@soil.com anytime", ROSTER)).toEqual([]);
  });

  it("matches mentions inside code fences (documented behavior)", () => {
    const content = "```\n@[Soil Scientist] see this snippet\n```";
    expect(extractMentions(content, ROSTER)).toEqual(["Soil Scientist"]);
  });

  it("ignores bare text that no role starts with", () => {
    expect(extractMentions("@everyone please look at this", ROSTER)).toEqual([]);
  });
});

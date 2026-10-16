import { describe, expect, it } from "vitest";
import { extractMentions } from "../shared/mentions";

const roles = ["Soil Scientist", "Irrigation Engineer", "Pest Management", "Farm Finance Advisor", "Equipment & Machinery Specialist"];
const experts = [{ name: "Pest Expert", role: "Pest Management" }, { name: "Grandpa Joe", role: "Farm Finance Advisor" }];

describe("@mention variants resolve to roles", () => {
  it.each([
    ["@Pest Expert please look", "Pest Management"],
    ["@Pest Management please look", "Pest Management"],
    ["@pest please look", "Pest Management"],
    ["@[pest management] please", "Pest Management"],
    ["@Grandpa Joe what does it cost?", "Farm Finance Advisor"],
    ["@Equipment & Machinery Specialist calibrate", "Equipment & Machinery Specialist"],
  ])("%s", (text, role) => {
    expect(extractMentions(text, roles, experts)).toEqual([role]);
  });
  it("ignores emails and unknown names", () => {
    expect(extractMentions("mail me at joe@soil.com", roles, experts)).toEqual([]);
    expect(extractMentions("@Nobody here", roles, experts)).toEqual([]);
  });
});

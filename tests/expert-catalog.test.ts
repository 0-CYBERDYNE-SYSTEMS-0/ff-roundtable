import { describe, expect, it } from "vitest";
import { EXPERT_CATALOG, catalogAvatar, findCatalogExpert, TIER_EXPERT_LIMITS } from "../shared/expert-catalog";
import { TIERS } from "../server/tiers";

const TARGET_ROLES = [
  "Crop Specialist", "Soil Scientist", "Irrigation Engineer", "Pest Management", "Livestock Veterinarian",
  "Dairy Specialist", "Farm Finance Advisor", "Commodity Marketing Advisor", "Equipment & Machinery Specialist",
  "Meteorologist", "Organic Certification Advisor", "Food Safety Specialist", "Farm Labor & HR Advisor",
  "Grants & USDA Programs Advisor", "Precision Ag & Drone Specialist", "Orchard & Vineyard Specialist",
  "Greenhouse & Controlled Environment Specialist",
];

describe("expert catalog", () => {
  it("covers all 17 target roles with unique names and real prompts", () => {
    for (const role of TARGET_ROLES) expect(findCatalogExpert(role), role).toBeDefined();
    expect(new Set(EXPERT_CATALOG.map(e => e.role)).size).toBe(EXPERT_CATALOG.length);
    for (const e of EXPERT_CATALOG) {
      expect(e.rolePrompt.length, e.role).toBeGreaterThan(80);
      expect(e.defaultModel.endsWith(":free"), e.role).toBe(true);
    }
  });
  it("avatars are self-contained data URIs (no external hosts)", () => {
    for (const e of EXPERT_CATALOG) expect(catalogAvatar(e.role)).toMatch(/^data:image\/svg\+xml/);
    expect(catalogAvatar("Beekeeper")).toMatch(/^data:image\/svg\+xml/);
  });
  it("UI tier copy matches server tiers", () => {
    expect(TIER_EXPERT_LIMITS.free).toBe(TIERS.free.maxExperts);
    expect(TIER_EXPERT_LIMITS.pro).toBe(TIERS.pro.maxExperts);
  });
});

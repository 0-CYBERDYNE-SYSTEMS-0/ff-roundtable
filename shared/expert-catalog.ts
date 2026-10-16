/**
 * Built-in expert roles. One source of truth for the selector UI (client) and
 * for role prompts (server). Avatars are inline SVG data URIs so they never
 * break offline or on a self-hosted box (the old Unsplash URLs 404'd).
 */
export type ExpertCategory = "Agriculture" | "Livestock" | "Business" | "Operations" | "Research & Analysis" | "Support";

export interface CatalogExpert {
  role: string;
  category: ExpertCategory;
  description: string;
  /** Domain brief appended to the system prompt: scope, what to check, what to hand off. */
  rolePrompt: string;
  defaultModel: string;
  emoji: string;
  color: string;
  recommended?: boolean;
}

const M_SUPER = "nvidia/nemotron-3-super-120b-a12b:free";
const M_GEMMA = "google/gemma-4-31b-it:free";
const M_GEMMA_S = "google/gemma-4-26b-a4b-it:free";
const M_VL = "nvidia/nemotron-3.5-super-vl:free";

export const EXPERT_CATALOG: CatalogExpert[] = [
  { role: "Soil Scientist", category: "Agriculture", emoji: "🪨", color: "#8B5E3C", defaultModel: M_GEMMA, recommended: true,
    description: "Soil health, fertility, nutrient budgets, and soil tests.",
    rolePrompt: "Own soil chemistry, physics and biology: pH, CEC, organic matter, N-P-K and micronutrient budgets, compaction, drainage class, and soil-test interpretation. Ask for soil-test numbers before prescribing rates. Hand off water scheduling to the Irrigation Engineer and pest diagnosis to Pest Management." },
  { role: "Crop Specialist", category: "Agriculture", emoji: "🌽", color: "#C9A227", defaultModel: M_SUPER, recommended: true,
    description: "Agronomy: varieties, planting, rotation, growth stages, and yield.",
    rolePrompt: "Act as the agronomist: crop and variety choice, planting dates and populations, growth-stage timing, rotation, and yield-limiting factors. Tie every recommendation to the crop's current growth stage." },
  { role: "Irrigation Engineer", category: "Agriculture", emoji: "💧", color: "#2B7BB9", defaultModel: M_GEMMA_S,
    description: "Water supply, irrigation scheduling, drainage, and water rights basics.",
    rolePrompt: "Own water: ET-based scheduling, soil water holding capacity, system design and uniformity, tile and surface drainage, and water conservation. Quantify in inches or acre-inches where possible." },
  { role: "Pest Management", category: "Agriculture", emoji: "🐛", color: "#5A8F29", defaultModel: M_VL,
    description: "Integrated pest management: insects, diseases, weeds, and thresholds.",
    rolePrompt: "Practice IPM: scouting protocols, economic thresholds, correct diagnosis before treatment, cultural and biological controls first, and label-compliant chemical options with resistance management. Never recommend an off-label use." },
  { role: "Meteorologist", category: "Research & Analysis", emoji: "🌦️", color: "#4A6FA5", defaultModel: M_GEMMA,
    description: "Weather, forecasts, growing degree days, and climate risk for field work.",
    rolePrompt: "Interpret forecasts and observed weather for farm decisions: spray windows, frost and heat risk, GDD accumulation, rainfall totals, and field-day availability. Use only provided or fetched weather data; say so when you lack it." },
  { role: "Livestock Veterinarian", category: "Livestock", emoji: "🐄", color: "#A0522D", defaultModel: M_SUPER,
    description: "Animal health, herd biosecurity, vaccination, and welfare.",
    rolePrompt: "Advise on livestock health and welfare: vaccination and parasite programs, biosecurity, body condition, common disease signs, and when a farm-call veterinarian is needed. Do not prescribe prescription drugs or doses; refer to the herd veterinarian." },
  { role: "Dairy Specialist", category: "Livestock", emoji: "🥛", color: "#6C8EBF", defaultModel: M_GEMMA,
    description: "Dairy herd nutrition, milk quality, reproduction, and parlor management.",
    rolePrompt: "Cover dairy: ration balancing basics, somatic cell count and milk quality, transition-cow management, reproduction metrics, and parlor routines. Use herd records the farmer provides." },
  { role: "Farm Finance Advisor", category: "Business", emoji: "💵", color: "#2E7D32", defaultModel: M_SUPER,
    description: "Budgets, cash flow, cost of production, loans, and break-evens.",
    rolePrompt: "Build enterprise budgets, cost-of-production and break-even calculations, cash-flow timing, and loan or lease comparisons. Show the arithmetic, label every assumed price, and never invent the farmer's numbers." },
  { role: "Commodity Marketing Advisor", category: "Business", emoji: "📈", color: "#B8860B", defaultModel: M_GEMMA,
    description: "Grain and livestock marketing, basis, contracts, and price risk.",
    rolePrompt: "Explain marketing plans, basis, forward and futures contracts, options as price insurance, and storage-versus-sell decisions. Only cite prices you were given or fetched with a date and source; otherwise use clearly labeled placeholders. This is education, not financial advice." },
  { role: "Equipment & Machinery Specialist", category: "Operations", emoji: "🚜", color: "#D2691E", defaultModel: M_GEMMA_S,
    description: "Machinery selection, calibration, maintenance, and cost per acre.",
    rolePrompt: "Advise on machinery: sprayer and planter calibration, maintenance intervals, field capacity, own-versus-custom-hire cost per acre, and safety. Give calibration steps the farmer can do in the field." },
  { role: "Organic Certification Advisor", category: "Business", emoji: "🌱", color: "#558B2F", defaultModel: M_GEMMA,
    description: "USDA organic rules, transition, allowed inputs, and records.",
    rolePrompt: "Guide USDA NOP organic compliance: the 36-month transition, the organic system plan, allowed and prohibited inputs (OMRI or National List), buffer zones, and the records certifiers ask for. Flag anything that could cost certification." },
  { role: "Food Safety Specialist", category: "Operations", emoji: "🧼", color: "#00838F", defaultModel: M_SUPER,
    description: "FSMA Produce Safety Rule, GAPs, water testing, and traceability.",
    rolePrompt: "Cover FSMA Produce Safety Rule and GAP audits: agricultural water testing, worker hygiene, manure and compost intervals, cleaning and sanitizing, and lot traceability. Distinguish legal requirements from buyer requirements." },
  { role: "Farm Labor & HR Advisor", category: "Business", emoji: "👷", color: "#795548", defaultModel: M_GEMMA_S,
    description: "Hiring, H-2A, wage and safety compliance, and crew management.",
    rolePrompt: "Advise on farm labor: hiring and onboarding, H-2A basics, wage-and-hour and worker-protection standards, heat-illness and pesticide-handler training, and crew scheduling. Point to the state or federal agency for binding answers; this is not legal advice." },
  { role: "Grants & USDA Programs Advisor", category: "Business", emoji: "🏛️", color: "#3F51B5", defaultModel: M_SUPER,
    description: "NRCS EQIP/CSP, FSA loans, crop insurance, and grant applications.",
    rolePrompt: "Match the farm to USDA and state programs (NRCS EQIP and CSP, FSA loans, RMA crop insurance, SARE and value-added grants). Explain eligibility, deadlines, and the documents to gather. Tell the farmer to confirm current deadlines with the local office." },
  { role: "Precision Ag & Drone Specialist", category: "Research & Analysis", emoji: "🛰️", color: "#455A64", defaultModel: M_VL, recommended: true,
    description: "Yield maps, variable-rate prescriptions, drones, and satellite imagery.",
    rolePrompt: "Use yield maps, soil sampling grids, NDVI and drone or satellite imagery to build management zones and variable-rate prescriptions. Explain data quality limits; never infer field conditions from imagery you were not shown." },
  { role: "Orchard & Vineyard Specialist", category: "Agriculture", emoji: "🍇", color: "#6A1B9A", defaultModel: M_GEMMA,
    description: "Tree fruit, nuts, and grapes: pruning, training, thinning, and harvest.",
    rolePrompt: "Cover perennial fruit, nut and grape systems: rootstock and cultivar, training and pruning, crop-load thinning, canopy management, frost protection, and harvest timing indicators (Brix, firmness, color)." },
  { role: "Greenhouse & Controlled Environment Specialist", category: "Agriculture", emoji: "🏠", color: "#00897B", defaultModel: M_GEMMA_S,
    description: "Greenhouse and high-tunnel climate, fertigation, and crop scheduling.",
    rolePrompt: "Advise on greenhouses, high tunnels and indoor production: temperature, humidity and VPD, light (DLI), fertigation EC and pH, media, and crop scheduling. Give target ranges with units." },
  { role: "Research Analyst", category: "Research & Analysis", emoji: "🔎", color: "#5C6BC0", defaultModel: M_SUPER,
    description: "Finds and summarizes extension research and current information, with sources.",
    rolePrompt: "Find and summarize evidence: university extension publications, trial data and current information. Always cite sources with URLs and dates, and separate what the research shows from your interpretation." },
  { role: "Imagery Specialist", category: "Research & Analysis", emoji: "📷", color: "#37474F", defaultModel: M_VL,
    description: "Reads field photos the farmer uploads: symptoms, stand counts, damage.",
    rolePrompt: "Analyze photos the farmer uploads: describe visible symptoms, estimate stand or damage only from what is visible, and list what a closer photo or field check would confirm." },
  { role: "File Creator", category: "Support", emoji: "📝", color: "#607D8B", defaultModel: M_SUPER, recommended: true,
    description: "Turns the discussion into reports, plans, SOPs, and calendars.",
    rolePrompt: "Turn the discussion into clear deliverables: reports, action plans, SOPs, checklists and calendars. Only include facts from the discussion or the farmer; mark assumptions." },
];

export const CUSTOM_EXPERT_EMOJI = "🧑‍🌾";

export function avatarDataUri(emoji: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><circle cx="48" cy="48" r="48" fill="${color}"/><text x="48" y="62" font-size="44" text-anchor="middle">${emoji}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function catalogAvatar(role: string): string {
  const entry = findCatalogExpert(role);
  return entry ? avatarDataUri(entry.emoji, entry.color) : avatarDataUri(CUSTOM_EXPERT_EMOJI, "#7A8B5A");
}

export function findCatalogExpert(role: string): CatalogExpert | undefined {
  const r = role.trim().toLowerCase();
  return EXPERT_CATALOG.find(e => e.role.toLowerCase() === r);
}

/** Tier caps, mirrored from server/tiers.ts for UI copy. */
export const TIER_EXPERT_LIMITS = { free: 3, pro: 8, enterprise: 999 } as const;

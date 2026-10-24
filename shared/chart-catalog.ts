// Chart catalog for the dynamic chart picker (FF_PREMIUM_CHARTS).
// Organised by intent (after the FT Visual Vocabulary / data-to-viz): each entry says when
// the chart fits and gives one compact, valid FarmFriend envelope on fictional example data.
// Specs never carry config, colours, fonts or nested data — the renderer injects the theme.

export type ChartIntent = "change" | "part" | "rank" | "deviation" | "correlation" | "distribution" | "flow" | "spatial" | "schedule" | "magnitude" | "uncertainty";

export type ChartCatalogEntry = {
  id: string;
  name: string;
  intents: ChartIntent[];
  /** Words in a request that point straight at this chart. */
  cues: RegExp;
  /** Data shape and the decision the chart serves, in one line. */
  when: string;
  /** Pitfall to avoid. */
  avoid: string;
  example: { type: "vega-lite"; title: string; description: string; theme: "farmfriend"; sources: string[]; data: Record<string, string | number>[]; spec: Record<string, unknown> };
};

const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ex = (title: string, description: string, data: Record<string, string | number>[], spec: Record<string, unknown>) =>
  ({ type: "vega-lite" as const, title: `Illustrative: ${title}`, description, theme: "farmfriend" as const, sources: ["assumptions"], data, spec });
const long = (series: Record<string, number[]>, xs: (string | number)[], xKey: string, sKey: string, vKey: string) =>
  Object.entries(series).flatMap(([s, vals]) => vals.map((v, i) => ({ [xKey]: xs[i], [sKey]: s, [vKey]: v })));
const tt = (...f: string[]) => f.map(field => ({ field }));

export const CHART_CATALOG: ChartCatalogEntry[] = [
  { id: "multi-area", name: "Overlapping multi-area", intents: ["change"], cues: /season|peak|overlap|multi.?area|monthly .* by (crop|field)/i,
    when: "A few (2–5) series over time where peaks and overlap matter more than the total.", avoid: "Stacking non-additive series; more than 5 series.",
    example: ex("harvest peaks by crop, 40-acre vegetable farm", "Assumed typical monthly harvest (tons).", long({ "Sweet corn": [0, 0, 0, 0, 2, 14, 48, 92, 70, 18, 0, 0], Tomatoes: [0, 0, 0, 0, 0, 8, 36, 64, 58, 30, 4, 0], Greens: [6, 10, 22, 40, 52, 44, 26, 22, 30, 36, 24, 10] }, M, "month", "crop", "tons"),
      { layer: [{ mark: { type: "area", opacity: 0.25, interpolate: "monotone" } }, { mark: { type: "line", interpolate: "monotone", strokeWidth: 2.5 } }],
        encoding: { x: { field: "month", type: "ordinal", sort: M, title: null }, y: { field: "tons", type: "quantitative", stack: null, title: "Harvest (tons)" }, color: { field: "crop", type: "nominal", title: null }, tooltip: tt("month", "crop", "tons") } }) },
  { id: "stacked-area", name: "Stacked area", intents: ["change", "part"], cues: /stack|total .* (over|by) (month|year|season)|cost.*(categor|breakdown)|spend/i,
    when: "Additive categories over time where both the total and each share matter (costs, sales, acres).", avoid: "Stacking rates, averages or percentages that do not sum.",
    example: ex("monthly input spend by category, 1,200 ac corn/soy", "Assumed spend, $ thousands.", long({ Seed: [0, 4, 18, 22, 6, 0], Fertilizer: [0, 6, 24, 30, 14, 8], Fuel: [2, 2, 6, 10, 12, 10], Labor: [4, 4, 8, 14, 18, 22] }, M.slice(0, 6), "month", "category", "k"),
      { mark: { type: "area", interpolate: "monotone", line: { strokeWidth: 1 } }, encoding: { x: { field: "month", type: "ordinal", sort: M, title: null }, y: { field: "k", type: "quantitative", stack: "zero", title: "Spend ($ thousands)" }, color: { field: "category", type: "nominal", title: null }, tooltip: tt("month", "category", "k") } }) },
  { id: "streamgraph", name: "Streamgraph", intents: ["change", "part"], cues: /stream|channel|mix over|weekly sales/i,
    when: "Many (4–7) additive categories over a long time axis where the shape of the mix matters more than exact values.", avoid: "When readers need exact values — use stacked area.",
    example: ex("weekly sales by channel", "Assumed $ thousands per week.", long({ CSA: [1, 2, 4, 7, 9, 8, 5, 2], Markets: [0.5, 1, 3, 5, 6, 5, 3, 1], Wholesale: [2, 2, 3, 4, 5, 5, 4, 3] }, [10, 15, 20, 25, 30, 35, 40, 45], "week", "channel", "k"),
      { mark: { type: "area", interpolate: "basis" }, encoding: { x: { field: "week", type: "quantitative", title: "Week of year" }, y: { field: "k", type: "quantitative", stack: "center", axis: null }, color: { field: "channel", type: "nominal", title: null }, tooltip: tt("week", "channel", "k") } }) },
  { id: "normalized-area", name: "100% stacked area", intents: ["part", "change"], cues: /share|percent(age)? of|proportion|mix shift/i,
    when: "How the share of a whole shifts over time (crop mix, land use, revenue share).", avoid: "Hiding a changing total — mention it.",
    example: ex("crop share of planted acres, 2019–2026", "Assumed acres by crop.", long({ Corn: [600, 620, 580, 560, 540, 520, 500, 480], Soybeans: [400, 380, 420, 430, 440, 450, 460, 470], Cover: [0, 20, 40, 60, 90, 120, 150, 180] }, [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026], "year", "crop", "acres"),
      { mark: { type: "area" }, encoding: { x: { field: "year", type: "ordinal", title: null }, y: { field: "acres", type: "quantitative", stack: "normalize", title: "Share of acres", axis: { format: "%" } }, color: { field: "crop", type: "nominal", title: null }, tooltip: tt("year", "crop", "acres") } }) },
  { id: "line-multi", name: "Multi-series line", intents: ["change"], cues: /trend|over (time|the years)|price|history/i,
    when: "Precise trends of 1–6 series over time (prices, yields, temperatures).", avoid: "Too many lines — facet instead.",
    example: ex("local cash bids, corn vs soybeans", "Assumed $/bu.", long({ Corn: [4.4, 4.6, 4.3, 4.1, 4.2, 4.5], Soybeans: [10.8, 11.2, 10.6, 10.1, 10.4, 10.9] }, M.slice(4, 10), "month", "crop", "usd"),
      { mark: { type: "line", point: true, interpolate: "monotone" }, encoding: { x: { field: "month", type: "ordinal", sort: M, title: null }, y: { field: "usd", type: "quantitative", scale: { zero: false }, title: "Cash bid ($/bu)" }, color: { field: "crop", type: "nominal", title: null }, tooltip: tt("month", "crop", "usd") } }) },
  { id: "dual-axis", name: "Layered bars + line, two axes", intents: ["change", "correlation"], cues: /rain(fall)?.*(moisture|yield)|moisture.*rain|vs\.? |versus|against|dual|two (units|measures)/i,
    when: "Two measures with DIFFERENT units on one time axis (rain mm + soil moisture %, price + volume). Add a threshold with a datum rule.", avoid: "Implying the two units are comparable; label each axis with its unit and colour.",
    example: ex("daily rain vs soil moisture, Field 7", "Assumed mm and % VWC; 20% refill point.", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((d, i) => ({ date: `2026-06-${String(d).padStart(2, "0")}`, rain: [12, 0, 0, 0, 22, 3, 0, 0, 0, 0][i], moisture: [30, 29, 27.5, 26, 33, 33, 31, 29, 27, 25][i] })),
      { encoding: { x: { field: "date", type: "temporal", title: null, axis: { format: "%b %d" } } },
        layer: [{ mark: { type: "bar", opacity: 0.55, color: "#3B82A6" }, encoding: { y: { field: "rain", type: "quantitative", title: "Rainfall (mm)", axis: { titleColor: "#3B82A6" } } } },
          { layer: [{ mark: { type: "line", color: "#2F7D4F", strokeWidth: 3, interpolate: "monotone", point: true }, encoding: { y: { field: "moisture", type: "quantitative", scale: { domain: [15, 40] }, title: "Soil moisture (% VWC)", axis: { orient: "right", titleColor: "#2F7D4F" } } } },
            { mark: { type: "rule", strokeDash: [6, 4], color: "#B5653A" }, encoding: { x: null, y: { datum: 20, type: "quantitative" } } }] }],
        resolve: { scale: { y: "independent" } } }) },
  { id: "small-multiples", name: "Small multiples (facet)", intents: ["change", "spatial"], cues: /each field|by field|per field|small multiples|facet|compare (fields|farms|sites)/i,
    when: "The same measure over time for 4–12 groups (fields, farms, varieties) — one mini chart per group, shared scale.", avoid: "Independent y scales unless ranges differ wildly (say so).",
    example: ex("corn yield by field, 2021–2026", "Assumed bu/ac.", long({ "North 80": [178, 184, 151, 187, 184, 192], "Creek Bottom": [182, 191, 167, 188, 201, 193], Hilltop: [156, 172, 137, 174, 170, 178], "Sandy 40": [150, 160, 120, 158, 162, 166] }, [2021, 2022, 2023, 2024, 2025, 2026], "year", "field", "bu"),
      { columns: 2, facet: { field: "field", type: "nominal", title: null }, spec: { width: 220, height: 110, layer: [{ mark: { type: "area", opacity: 0.25, interpolate: "monotone" } }, { mark: { type: "line", point: true, interpolate: "monotone" } }],
        encoding: { x: { field: "year", type: "ordinal", title: null, axis: { labelAngle: 0 } }, y: { field: "bu", type: "quantitative", scale: { domain: [100, 220] }, title: "bu/ac" }, color: { value: "#B7861A" }, tooltip: tt("field", "year", "bu") } } }) },
  { id: "heatmap", name: "Heatmap with labels", intents: ["change", "magnitude", "spatial"], cues: /heat ?map|by field and (week|month|day)|matrix|grid of/i,
    when: "A value across two categories (field × week, crop × month); spot hot/cold cells. Print values in cells when ≤ 150 cells.", avoid: "Rainbow colours; missing cells shown as zero.",
    example: ex("weekly soil moisture by field", "Assumed % VWC.", long({ "North 80": [30, 28, 24, 20, 17], "Creek Bottom": [38, 36, 33, 30, 29], "Sandy 40": [22, 19, 16, 13, 12] }, ["W24", "W25", "W26", "W27", "W28"], "week", "field", "vwc"),
      { layer: [{ mark: { type: "rect", cornerRadius: 3 }, encoding: { color: { field: "vwc", type: "quantitative", title: "% VWC", scale: { range: ["#C2603A", "#F4EED9", "#22663F"] } } } },
        { mark: { type: "text", fontWeight: 600 }, encoding: { text: { field: "vwc", type: "quantitative" } } }],
        encoding: { x: { field: "week", type: "ordinal", title: null, axis: { labelAngle: 0 } }, y: { field: "field", type: "nominal", title: null }, tooltip: tt("field", "week", "vwc") } }) },
  { id: "calendar-heatmap", name: "Calendar heatmap", intents: ["schedule", "change"], cues: /calendar|daily .* (year|season)|every day|day of week/i,
    when: "One value per day across weeks/months (rain, labour hours, egg counts) — weekday × week grid.", avoid: "Using it for fewer than ~4 weeks of data.",
    example: ex("daily rainfall, first 4 weeks of April", "Assumed mm per day.", Array.from({ length: 28 }, (_, i) => ({ date: `2026-04-${String(i + 1).padStart(2, "0")}`, mm: [0, 4, 12, 0, 0, 0, 2, 18, 6, 0, 0, 0, 0, 1, 0, 9, 22, 3, 0, 0, 0, 0, 0, 5, 0, 0, 14, 2][i] })),
      { mark: { type: "rect", cornerRadius: 3, stroke: "white", strokeWidth: 2 }, encoding: { x: { field: "date", timeUnit: "week", type: "ordinal", title: null, axis: { format: "W%U", labelAngle: 0 } }, y: { field: "date", timeUnit: "day", type: "ordinal", title: null }, color: { field: "mm", type: "quantitative", title: "Rain (mm)", scale: { range: ["#F4EED9", "#5FA3C7", "#163E5E"] } }, tooltip: [{ field: "date", type: "temporal" }, { field: "mm" }] } }) },
  { id: "gantt", name: "Timeline / Gantt", intents: ["schedule"], cues: /schedule|timeline|gantt|plan(ting)? (window|calendar)|when to|season plan|operations/i,
    when: "Tasks or crop windows with start and end dates (planting, spraying, harvest windows).", avoid: "Point events without durations — use a dot timeline.",
    example: ex("2026 field operations windows", "Assumed windows.", [{ task: "Tillage", start: "2026-03-20", end: "2026-04-10", crew: "Tractor" }, { task: "Plant corn", start: "2026-04-20", end: "2026-05-12", crew: "Planter" }, { task: "Side-dress N", start: "2026-06-01", end: "2026-06-15", crew: "Sprayer" }, { task: "Harvest", start: "2026-09-25", end: "2026-10-30", crew: "Combine" }],
      { mark: { type: "bar", cornerRadius: 5, height: 18 }, encoding: { y: { field: "task", type: "nominal", sort: null, title: null }, x: { field: "start", type: "temporal", title: null, axis: { format: "%b" } }, x2: { field: "end" }, color: { field: "crew", type: "nominal", title: null }, tooltip: [{ field: "task" }, { field: "start", type: "temporal" }, { field: "end", type: "temporal" }] } }) },
  { id: "scatter-trend", name: "Scatter with fitted trend", intents: ["correlation"], cues: /relationship|correlat|response|vs\.? yield|rate .* yield|does .* affect|scatter/i,
    when: "Two numeric measures per observation (N rate vs yield, price vs volume); size = acres, colour = group, add a regression line.", avoid: "Claiming causation; fitting a line to < 6 points.",
    example: ex("nitrogen rate vs corn yield, strip trials", "Assumed trial results; quadratic fit.", [[90, 162, "Silt"], [110, 178, "Silt"], [130, 190, "Clay"], [150, 198, "Silt"], [170, 205, "Clay"], [190, 207, "Silt"], [210, 206, "Clay"], [230, 204, "Silt"], [120, 180, "Clay"], [200, 209, "Silt"]].map(([n, bu, soil]) => ({ n, bu, soil })) as Record<string, string | number>[],
      { layer: [{ mark: { type: "point", filled: true, size: 120, opacity: 0.8 }, encoding: { color: { field: "soil", type: "nominal", title: null } } }, { mark: { type: "line", color: "#1F2E2A", strokeWidth: 2 }, transform: [{ regression: "bu", on: "n", method: "poly", order: 2 }] }],
        encoding: { x: { field: "n", type: "quantitative", scale: { zero: false }, title: "Nitrogen (lb/ac)" }, y: { field: "bu", type: "quantitative", scale: { zero: false }, title: "Yield (bu/ac)" }, tooltip: tt("n", "bu") } }) },
  { id: "diverging-bar", name: "Diverging bar", intents: ["deviation", "rank"], cues: /profit|loss|margin|above|below|vs\.? (normal|average|budget|target)|anomal|deviation|gain/i,
    when: "Signed values around zero or a baseline (margin per acre, rain vs normal, budget variance), sorted.", avoid: "Unsorted bars; one colour for gains and losses.",
    example: ex("net margin per acre by crop", "Assumed 2026 budget, $/ac.", [{ crop: "Garlic", usd: 4200 }, { crop: "Strawberries", usd: 3100 }, { crop: "Tomatoes", usd: 2650 }, { crop: "Sweet corn", usd: 380 }, { crop: "Pumpkins", usd: -150 }, { crop: "Field peas", usd: -420 }],
      { layer: [{ mark: { type: "bar", cornerRadiusEnd: 4 }, encoding: { color: { condition: { test: "datum.usd < 0", value: "#C2603A" }, value: "#2F7D4F" } } }, { mark: { type: "text", align: "left", dx: 5, fontWeight: 600 }, encoding: { text: { field: "usd", type: "quantitative", format: "$,d" } } }],
        encoding: { y: { field: "crop", type: "nominal", sort: "-x", title: null }, x: { field: "usd", type: "quantitative", title: "Net margin ($/ac)", axis: { format: "$,d" } }, tooltip: tt("crop", "usd") } }) },
  { id: "ranked-lollipop", name: "Ranked lollipop / bar", intents: ["rank", "magnitude"], cues: /rank|top|best|worst|highest|lowest|compare (varieties|hybrids|options)|which .* (most|least)/i,
    when: "One value per item, ranked (variety yields, supplier prices, field scores). Lollipops stay clean with many items.", avoid: "Alphabetical order; truncated bar axes.",
    example: ex("soybean variety trial yields", "Assumed bu/ac.", [["AG 31X", 68.4], ["P 28A", 66.1], ["Credenz 2", 64.9], ["NK 30-E", 63.0], ["Asgrow 27", 61.2], ["Local check", 57.5]].map(([variety, bu]) => ({ variety, bu })) as Record<string, string | number>[],
      { layer: [{ mark: { type: "rule", strokeWidth: 3, opacity: 0.5 }, encoding: { x: { datum: 50 }, x2: { field: "bu" } } }, { mark: { type: "point", filled: true, size: 160 } }, { mark: { type: "text", align: "left", dx: 10, fontWeight: 600 }, encoding: { text: { field: "bu" } } }],
        encoding: { y: { field: "variety", type: "nominal", sort: "-x", title: null }, x: { field: "bu", type: "quantitative", scale: { domain: [50, 72] }, title: "Yield (bu/ac)" }, color: { value: "#2F7D4F" }, tooltip: tt("variety", "bu") } }) },
  { id: "grouped-bar", name: "Grouped bar", intents: ["magnitude"], cues: /grouped|side.?by.?side|compare .* (and|across)|by (year|treatment) and/i,
    when: "A few categories × 2–4 sub-groups where direct side-by-side comparison matters (treatment vs control per field).", avoid: "More than 4 sub-groups.",
    example: ex("yield with vs without cover crop", "Assumed bu/ac.", long({ "No cover": [182, 175, 160], "Cereal rye": [186, 181, 171] }, ["North 80", "Creek Bottom", "Hilltop"], "field", "treatment", "bu"),
      { mark: { type: "bar", cornerRadiusTopLeft: 4, cornerRadiusTopRight: 4 }, encoding: { x: { field: "field", type: "nominal", title: null, axis: { labelAngle: 0 } }, xOffset: { field: "treatment" }, y: { field: "bu", type: "quantitative", title: "Yield (bu/ac)" }, color: { field: "treatment", type: "nominal", title: null }, tooltip: tt("field", "treatment", "bu") } }) },
  { id: "stacked-bar", name: "Stacked / 100% bar", intents: ["part", "magnitude"], cues: /breakdown|composition|made up of|split by|cost per acre/i,
    when: "Part-to-whole for several items (cost per acre by component for each crop). Use stack:'normalize' for shares.", avoid: "More than ~6 segments.",
    example: ex("cost of production per acre", "Assumed $/ac.", long({ Seed: [118, 62], Fertilizer: [165, 38], Chemicals: [48, 44], Machinery: [95, 82], Land: [260, 260] }, ["Corn", "Soybeans"], "crop", "item", "usd"),
      { mark: { type: "bar", height: 34 }, encoding: { y: { field: "crop", type: "nominal", title: null }, x: { field: "usd", type: "quantitative", title: "Cost ($/ac)", axis: { format: "$,d" } }, color: { field: "item", type: "nominal", title: null }, tooltip: tt("crop", "item", "usd") } }) },
  { id: "donut", name: "Donut", intents: ["part"], cues: /pie|donut|doughnut|share of (total|land|revenue)/i,
    when: "One whole split into 2–5 parts where rough shares matter (land use, revenue mix).", avoid: "More than 5 slices or comparing two donuts — use bars.",
    example: ex("land use on a 320-acre farm", "Assumed acres.", [{ use: "Corn", acres: 140 }, { use: "Soybeans", acres: 110 }, { use: "Pasture", acres: 45 }, { use: "Woodlot", acres: 25 }],
      { layer: [{ mark: { type: "arc", innerRadius: 70, padAngle: 0.02, cornerRadius: 4 } }, { mark: { type: "text", radius: 128, fontWeight: 600 }, encoding: { text: { field: "acres" } } }],
        encoding: { theta: { field: "acres", type: "quantitative", stack: true }, color: { field: "use", type: "nominal", title: null }, tooltip: tt("use", "acres") } }) },
  { id: "slope", name: "Slope chart", intents: ["change", "rank"], cues: /before (and|vs) after|last year (vs|and) this year|from .* to|between two|slope/i,
    when: "Change for several items between exactly two points (2025 vs 2026, before vs after a practice).", avoid: "More than two time points — use lines.",
    example: ex("organic matter before vs after 5 years of cover crops", "Assumed % OM.", long({ "North 80": [2.6, 3.1], "Creek Bottom": [3.4, 3.7], Hilltop: [1.9, 2.5], "Sandy 40": [1.2, 1.5] }, ["2021", "2026"], "year", "field", "om"),
      { layer: [{ mark: { type: "line", strokeWidth: 3 } }, { mark: { type: "point", filled: true, size: 110 } }, { mark: { type: "text", align: "left", dx: 10 }, encoding: { text: { field: "field" } }, transform: [{ filter: "datum.year == '2026'" }] }],
        encoding: { x: { field: "year", type: "ordinal", title: null, axis: { labelAngle: 0 }, scale: { padding: 0.3 } }, y: { field: "om", type: "quantitative", scale: { zero: false }, title: "Organic matter (%)" }, color: { field: "field", type: "nominal", legend: null }, tooltip: tt("field", "year", "om") } }) },
  { id: "bump", name: "Bump chart", intents: ["rank", "change"], cues: /rank(ing)? (over|by) (year|season)|position|standings|bump/i,
    when: "How the RANK of items changes over several periods (top-selling crops each year, county yield ranking).", avoid: "Using it when the values themselves matter.",
    example: ex("crop revenue rank, 2022–2026", "Assumed rank (1 = highest revenue).", long({ Garlic: [3, 2, 1, 1, 1], Tomatoes: [1, 1, 2, 3, 2], Berries: [2, 3, 3, 2, 3], Squash: [4, 4, 4, 4, 4] }, [2022, 2023, 2024, 2025, 2026], "year", "crop", "rank"),
      { layer: [{ mark: { type: "line", strokeWidth: 4, interpolate: "monotone" } }, { mark: { type: "point", filled: true, size: 220 } }],
        encoding: { x: { field: "year", type: "ordinal", title: null, axis: { labelAngle: 0 } }, y: { field: "rank", type: "ordinal", title: "Rank", scale: { domain: [1, 2, 3, 4] } }, color: { field: "crop", type: "nominal", title: null }, tooltip: tt("crop", "year", "rank") } }) },
  { id: "waterfall", name: "Waterfall", intents: ["part", "deviation", "flow"], cues: /waterfall|bridge|walk|from revenue to|how (we|i) got|profit (and|&) loss|p&l|where .* (money|dollar) goes/i,
    when: "How a starting value moves to an end value through positive and negative steps (revenue → costs → net income).", avoid: "Unordered steps; missing the end total.",
    example: ex("revenue to net income per acre, corn", "Assumed $/ac; computed running total.", [{ step: "Revenue", amt: 940 }, { step: "Seed", amt: -118 }, { step: "Fertilizer", amt: -165 }, { step: "Machinery", amt: -95 }, { step: "Land rent", amt: -260 }, { step: "Other", amt: -120 }, { step: "Net income", amt: 0 }],
      { transform: [{ window: [{ op: "sum", field: "amt", as: "sum" }] }, { window: [{ op: "lead", field: "step", as: "lead" }] }, { calculate: "datum.step === 'Net income' ? 0 : datum.sum - datum.amt", as: "prev" }, { calculate: "datum.step === 'Net income' ? datum.sum : datum.sum", as: "end" }, { calculate: "datum.step === 'Net income' || datum.step === 'Revenue' ? 'total' : datum.amt < 0 ? 'cost' : 'gain'", as: "kind" }],
        layer: [{ mark: { type: "bar", cornerRadius: 3, width: { band: 0.7 } }, encoding: { y: { field: "prev", type: "quantitative", title: "$ per acre" }, y2: { field: "end" }, color: { field: "kind", type: "nominal", scale: { domain: ["total", "cost", "gain"], range: ["#2F7D4F", "#C2603A", "#7BAF5A"] }, legend: null } } },
          { mark: { type: "text", dy: -8, fontWeight: 600 }, encoding: { y: { field: "end", type: "quantitative" }, text: { field: "amt", type: "quantitative", format: "$,d" } } }],
        encoding: { x: { field: "step", type: "ordinal", sort: null, title: null, axis: { labelAngle: 0 } }, tooltip: tt("step", "amt") } }) },
  { id: "boxplot", name: "Box plot", intents: ["distribution"], cues: /distribution|spread|variab|consisten|range of|box ?plot|outlier/i,
    when: "Spread of many observations per group (yield monitor samples by field, weights by pen); shows median, quartiles, outliers.", avoid: "Fewer than ~8 observations per group — show the dots.",
    example: ex("yield monitor samples by field", "Assumed bu/ac samples.", ["North 80", "Hilltop", "Sandy 40"].flatMap((field, f) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => ({ field, bu: Math.round([185, 160, 150][f] + Math.sin(i * 2.3 + f) * [10, 22, 15][f]) }))),
      { mark: { type: "boxplot", extent: 1.5, size: 46, median: { color: "white", strokeWidth: 2 } }, encoding: { x: { field: "field", type: "nominal", title: null, axis: { labelAngle: 0 } }, y: { field: "bu", type: "quantitative", scale: { zero: false }, title: "Yield (bu/ac)" }, color: { field: "field", type: "nominal", legend: null } } }) },
  { id: "ridgeline", name: "Ridgeline (density per group)", intents: ["distribution", "change"], cues: /ridgeline|joy ?plot|distribution (by|over|per) (month|year|season)|shape of/i,
    when: "How a distribution's shape shifts across ordered groups (daily max temperature by month, weaning weights by year).", avoid: "Few observations; unordered groups.",
    example: ex("daily max temperature by month", "Assumed °F samples.", ["May", "Jun", "Jul", "Aug"].flatMap((month, m) => Array.from({ length: 12 }, (_, i) => ({ month, f: Math.round([70, 80, 88, 86][m] + Math.sin(i * 1.7 + m) * 7) }))),
      { facet: { row: { field: "month", type: "ordinal", sort: ["May", "Jun", "Jul", "Aug"], title: null, header: { labelAngle: 0, labelAlign: "left" } } }, spacing: -14,
        spec: { width: 520, height: 46, transform: [{ density: "f", groupby: ["month"], extent: [55, 105] }], mark: { type: "area", interpolate: "monotone", opacity: 0.8, stroke: "white", strokeWidth: 1 },
          encoding: { x: { field: "value", type: "quantitative", title: "Daily max (°F)" }, y: { field: "density", type: "quantitative", axis: null }, color: { field: "month", type: "ordinal", legend: null, scale: { range: ["#7BAF5A", "#E0A526", "#D9734E", "#B5653A"] } } } }, resolve: { scale: { y: "independent" } } }) },
  { id: "histogram", name: "Histogram", intents: ["distribution"], cues: /histogram|how many .* (fall|are) (in|between)|frequency|bins?/i,
    when: "Distribution of one numeric variable (calf weights, soil test P, hail sizes).", avoid: "Too few or too many bins.",
    example: ex("soil test P across 40 grid samples", "Assumed ppm.", Array.from({ length: 40 }, (_, i) => ({ ppm: Math.round(28 + Math.sin(i * 1.3) * 12 + Math.cos(i * 0.7) * 6) })),
      { layer: [{ mark: { type: "bar", cornerRadiusTopLeft: 3, cornerRadiusTopRight: 3, color: "#2F7D4F" }, encoding: { x: { field: "ppm", bin: { step: 5 }, title: "Soil test P (ppm, Bray)" }, y: { aggregate: "count", title: "Samples" } } },
        { mark: { type: "rule", strokeDash: [5, 4], color: "#B5653A", strokeWidth: 2 }, encoding: { x: { datum: 20 } } }] }) },
  { id: "range-band", name: "Forecast / range band", intents: ["uncertainty", "change"], cues: /forecast|projection|uncertain|range|confidence|best.?case|worst.?case|scenario|outlook/i,
    when: "A central estimate with low/high bounds over time (price outlook, yield forecast, GDD projection).", avoid: "Showing a single line as if certain.",
    example: ex("December corn price outlook", "Assumed scenarios, $/bu.", ["Nov", "Dec", "Jan", "Feb", "Mar", "Apr"].map((month, i) => ({ month, mid: [4.3, 4.35, 4.4, 4.45, 4.5, 4.55][i], low: [4.3, 4.1, 3.95, 3.85, 3.8, 3.75][i], high: [4.3, 4.6, 4.85, 5.05, 5.2, 5.35][i] })),
      { encoding: { x: { field: "month", type: "ordinal", sort: null, title: null, axis: { labelAngle: 0 } } },
        layer: [{ mark: { type: "area", opacity: 0.22, color: "#E0A526" }, encoding: { y: { field: "low", type: "quantitative", scale: { zero: false }, title: "$/bu" }, y2: { field: "high" } } }, { mark: { type: "line", color: "#B7861A", strokeWidth: 3, point: true }, encoding: { y: { field: "mid", type: "quantitative" } } }] }) },
  { id: "candlestick", name: "Candlestick", intents: ["change", "uncertainty"], cues: /candle|ohlc|futures|open.*close|high.*low|trading range/i,
    when: "Open/high/low/close prices per period (futures, weekly auction prices).", avoid: "Using it for a single price series — use a line.",
    example: ex("weekly corn futures", "Assumed $/bu.", [["W1", 4.40, 4.52, 4.35, 4.48], ["W2", 4.48, 4.60, 4.44, 4.56], ["W3", 4.56, 4.58, 4.38, 4.41], ["W4", 4.41, 4.45, 4.30, 4.33], ["W5", 4.33, 4.50, 4.31, 4.47]].map(([week, open, high, low, close]) => ({ week, open, high, low, close })) as Record<string, string | number>[],
      { encoding: { x: { field: "week", type: "ordinal", title: null, axis: { labelAngle: 0 } }, y: { type: "quantitative", scale: { zero: false }, title: "$/bu" }, color: { condition: { test: "datum.open < datum.close", value: "#2F7D4F" }, value: "#C2603A" } },
        layer: [{ mark: "rule", encoding: { y: { field: "low" }, y2: { field: "high" } } }, { mark: { type: "bar", width: 18 }, encoding: { y: { field: "open" }, y2: { field: "close" } } }] }) },
  { id: "bullet", name: "Progress vs target (bullet)", intents: ["magnitude", "deviation"], cues: /target|goal|progress|budget used|% (done|complete)|on track|vs\.? plan/i,
    when: "Actual vs target for a few measures (acres planted vs plan, budget spent vs allotted).", avoid: "Gauges — bullets read faster.",
    example: ex("spring field-work progress vs plan", "Assumed acres.", [{ job: "Planted corn", done: 410, plan: 520 }, { job: "Planted soy", done: 180, plan: 470 }, { job: "Sprayed pre", done: 560, plan: 600 }],
      { layer: [{ mark: { type: "bar", color: "#E6E1D6", height: 26 }, encoding: { x: { field: "plan", type: "quantitative", title: "Acres" } } }, { mark: { type: "bar", color: "#2F7D4F", height: 12 }, encoding: { x: { field: "done", type: "quantitative" } } }, { mark: { type: "tick", color: "#1F2E2A", thickness: 3, size: 30 }, encoding: { x: { field: "plan", type: "quantitative" } } }],
        encoding: { y: { field: "job", type: "nominal", title: null }, tooltip: tt("job", "done", "plan") } }) },
  { id: "field-grid-map", name: "Field grid map", intents: ["spatial"], cues: /map|where on the farm|zone|grid sample|block|layout|spatial/i,
    when: "Values on a farm layout without GIS data — fields or grid cells placed by row/column (zone soil pH, pest counts by block).", avoid: "Pretending to be a real geographic map.",
    example: ex("soil pH by grid cell, North 80", "Assumed 2.5-acre grid samples.", Array.from({ length: 24 }, (_, i) => ({ col: (i % 6) + 1, row: Math.floor(i / 6) + 1, ph: +(6.4 + Math.sin(i * 0.9) * 0.5 - Math.floor(i / 6) * 0.15).toFixed(1) })),
      { layer: [{ mark: { type: "rect", cornerRadius: 4, stroke: "white", strokeWidth: 3 }, encoding: { color: { field: "ph", type: "quantitative", title: "pH", scale: { range: ["#C2603A", "#F4EED9", "#2F7D4F"], domainMid: 6.5 } } } }, { mark: { type: "text", fontWeight: 600 }, encoding: { text: { field: "ph" } } }],
        encoding: { x: { field: "col", type: "ordinal", title: "West → East", axis: { labelAngle: 0 } }, y: { field: "row", type: "ordinal", title: "North → South" }, tooltip: tt("row", "col", "ph") } }) },
];

export const CHART_CATALOG_IDS = CHART_CATALOG.map(e => e.id);

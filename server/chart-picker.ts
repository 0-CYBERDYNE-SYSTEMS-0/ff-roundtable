// Dynamic chart picker (FF_PREMIUM_CHARTS=1): classify the farmer's request by intent and data
// shape, then inject only the 1–3 best-fitting catalog examples plus a premium design brief.
import { CHART_CATALOG, type ChartCatalogEntry, type ChartIntent } from "../shared/chart-catalog";

export function premiumChartsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FF_PREMIUM_CHARTS === "1" || env.FF_PREMIUM_CHARTS === "true";
}

const INTENT_CUES: Record<ChartIntent, RegExp> = {
  change: /\b(over time|trend|season(al)?|monthly|weekly|daily|year(s|ly)?|history|since|month by month|through the (year|season)|growth|decline|forecast)\b/i,
  part: /\b(share|breakdown|composition|split|mix|portion|percent(age)? of|made up|allocation|where .* (goes|go)|cost per acre)\b/i,
  rank: /\b(rank(ing|ed)?|top \d+|highest|lowest|leader(board)?|in order)\b/i,
  deviation: /\b(profit|loss|margin|variance|above|below|vs\.? (normal|average|budget|plan|target)|anomal|deficit|surplus|over budget|under budget)\b/i,
  correlation: /\b(relationship|correlat|affect|impact of|response|vs\.?|versus|against|related|driv(e|es|er))\b/i,
  distribution: /\b(distribution|spread|range of|variab|consisten|outlier|histogram|how many .* (between|fall))\b/i,
  flow: /\b(flow|from .* to|waterfall|bridge|walk|p&l|cash ?flow|where the money)\b/i,
  spatial: /\b(map|where on|zone|grid|block|layout|location|spatial|across the (farm|field))\b/i,
  schedule: /\b(schedule|calendar|timeline|gantt|plan(ting)? window|when (to|should)|dates|operations|rotation plan)\b/i,
  magnitude: /\b(compare|comparison|how much|how big|size|amount|total|cost|yield|price)s?\b/i,
  uncertainty: /\b(forecast|projection|outlook|uncertain|scenario|best.?case|worst.?case|risk|confidence|range)\b/i,
};

const NAMED: Record<string, string[]> = {
  gantt: ["timeline", "time ?line"], "scatter-trend": ["scatter ?plot", "scatter"], donut: ["pie"], boxplot: ["box ?plot", "box and whisker"],
  "ranked-lollipop": ["lollipop"], "heatmap": ["heat ?map"], "field-grid-map": ["farm map", "field map", "grid map"], "range-band": ["fan chart", "confidence band"],
  bullet: ["bullet chart", "progress bar"], "small-multiples": ["facet(ed)?"], "stacked-area": ["stacked area"], "multi-area": ["multi[ -]?area", "area chart"],
  "line-multi": ["line chart", "line graph"], "grouped-bar": ["grouped bars?", "clustered bars?"], "stacked-bar": ["stacked bars?"], "dual-axis": ["two axes", "dual[ -]axis", "combo chart"],
  "calendar-heatmap": ["calendar heat ?map", "calendar view"], "normalized-area": ["100% (stacked )?area", "share over time"],
};

export type ChartClassification = { intents: ChartIntent[]; scores: Record<string, number> };

/** Scores every catalog entry: direct cue match (3) + each matching intent (2 for primary, 1 otherwise). */
export function classifyChartRequest(request: string): ChartClassification {
  const intents = (Object.keys(INTENT_CUES) as ChartIntent[]).filter(i => INTENT_CUES[i].test(request));
  const scores: Record<string, number> = {};
  for (const e of CHART_CATALOG) {
    // Explicit chart name ("heatmap", "timeline", "box plot") beats inferred intent.
    const named = new RegExp(`\\b(${[e.id.replace(/-/g, "[ -]?"), ...(NAMED[e.id] ?? [])].join("|")})`, "i").test(request);
    let s = (named ? 6 : 0) + (e.cues.test(request) ? 3 : 0);
    e.intents.forEach((i, idx) => { if (intents.includes(i)) s += idx === 0 ? 2 : 1; });
    scores[e.id] = s;
  }
  return { intents, scores };
}

const DEFAULTS = ["multi-area", "ranked-lollipop", "stacked-bar"];

/** Best 1–3 entries, diverse by primary intent; falls back to versatile defaults. */
export function pickChartExamples(request: string, max = 3): ChartCatalogEntry[] {
  const { scores } = classifyChartRequest(request);
  const ranked = CHART_CATALOG.filter(e => scores[e.id] > 0).sort((a, b) => scores[b.id] - scores[a.id] || CHART_CATALOG.indexOf(a) - CHART_CATALOG.indexOf(b));
  const out: ChartCatalogEntry[] = [];
  const seenPrimary = new Set<string>();
  for (const e of ranked) { if (out.length >= max) break; if (seenPrimary.has(e.intents[0]) && scores[e.id] < 3) continue; out.push(e); seenPrimary.add(e.intents[0]); }
  for (const e of ranked) { if (out.length >= max) break; if (!out.includes(e)) out.push(e); }
  for (const id of DEFAULTS) { if (out.length >= Math.min(max, 2)) break; const e = CHART_CATALOG.find(c => c.id === id)!; if (!out.includes(e)) out.push(e); }
  return out.slice(0, max);
}

const MENU = CHART_CATALOG.map(e => `${e.id} (${e.intents[0]})`).join(", ");

export function buildChartPickerPrompt(request: string): string {
  const picks = pickChartExamples(request);
  return `PREMIUM CHART BRIEF (fictional examples below are design references, never evidence):
1. Decide the INTENT first — change over time, part-to-whole, ranking, deviation, correlation, distribution, flow, spatial, schedule, magnitude or uncertainty — and the DATA SHAPE (time × series, category × value, two numerics, start/end dates, signed values…). Pick the chart that fits; the best fits for this request are shown below, but you may use any type from: ${MENU}.
2. Make it gorgeous and decision-ready: an insight headline as "title" (what the farmer should notice, with place/period), units in every axis title, sorted categories, direct labels or value text where helpful, tooltips, a datum rule for any threshold/target, ≤ 6 colours. Prefer layered compositions (area + line, bars + line on independent axes, marks + text labels) and facets over plain single-mark charts.
3. Envelope rules: {"type":"vega-lite","title","description","theme":"farmfriend","sources","data":[flat rows],"spec":{…}}. Data as long-format rows with numbers as numbers; spec has NO data, datasets, url, config, $schema or width/height for single views. Use "datum" for constant reference lines. Every brace closed; strict JSON (double-quoted keys, no comments, no trailing commas). Put it in ONE \`\`\`chart fence.
4. Real numbers first (farmer, weather, research sources). If none exist, start the title "Illustrative:" with sources ["assumptions"] and list assumptions in description.

${picks.map(e => `FIT: ${e.name} [${e.id}] — ${e.when} Avoid: ${e.avoid}\n${JSON.stringify(e.example)}`).join("\n\n")}`;
}

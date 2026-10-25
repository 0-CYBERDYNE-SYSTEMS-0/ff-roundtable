import { z } from "zod";

export const visualThemes = {
  earth: ["#276354", "#447b9d", "#b77835", "#866394", "#6c7837", "#bd6262"],
  ocean: ["#216582", "#487e70", "#a66b40", "#77609c", "#a64f68", "#687337"],
  ink: ["#35465e", "#9b6336", "#457c76", "#886487", "#7e792f", "#ae5760"],
  farmfriend: ["#2F7D4F", "#E0A526", "#3B82A6", "#B5653A", "#7BAF5A", "#8A6FB0", "#D9734E", "#5E8C8A"],
} as const;

export const vegaChartSchema = z.object({
  type: z.literal("vega-lite"),
  title: z.string().trim().min(1).max(180),
  description: z.string().max(1200).optional(),
  theme: z.enum(["earth", "ocean", "ink", "farmfriend"]).default("earth"),
  sources: z.array(z.string().min(1)).min(1).max(30),
  data: z.array(z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.null()]))).min(1).max(5000),
  spec: z.record(z.unknown()),
});

export type VegaChart = z.infer<typeof vegaChartSchema>;

/** One inline dataset; no remote loaders, images, links, or executable HTML. */
export function parseVegaChart(value: unknown): VegaChart | null {
  const result = vegaChartSchema.safeParse(value);
  if (!result.success) return null;
  const spec = result.data.spec;
  if (!["mark", "layer", "facet", "repeat", "concat", "hconcat", "vconcat"].some(key => key in spec)) return null;
  function safe(node: unknown, depth = 0): boolean {
    if (depth > 40) return false;
    if (Array.isArray(node)) return node.every(item => safe(item, depth + 1));
    if (!node || typeof node !== "object") return true;
    return Object.entries(node).every(([key, child]) => {
      if (["data", "datasets", "url", "href", "usermeta", "__proto__", "constructor", "prototype"].includes(key)) return false;
      if ((key === "mark" && child === "image") || (key === "type" && child === "image")) return false;
      return safe(child, depth + 1);
    });
  }
  return safe(spec) ? result.data : null;
}

/** Theme defaults leave encodings, composition, transforms, and interactions to the expert. */
const NUMERIC_STRING = /^\s*[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*$/;

/** Models often quote numbers or type measures as ordinal; fix both so bars and lines scale. */
export function normalizeChartData(chart: VegaChart): { data: VegaChart["data"]; numeric: Set<string> } {
  const fields = Array.from(new Set(chart.data.flatMap(row => Object.keys(row))));
  const numeric = new Set<string>();
  for (const f of fields) {
    const vals = chart.data.map(r => (r as Record<string, unknown>)[f]).filter(v => v !== null && v !== undefined && v !== "");
    if (vals.length && vals.every(v => typeof v === "number" || (typeof v === "string" && NUMERIC_STRING.test(v)))) numeric.add(f);
  }
  const data = chart.data.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) =>
    [k, numeric.has(k) && typeof v === "string" ? Number(v.replace(/,/g, "")) : v]))) as VegaChart["data"];
  return { data, numeric };
}

const MEASURE_CHANNELS = new Set(["y", "y2", "size", "theta", "radius"]);
const CATEGORY_CHANNELS = new Set(["x", "y", "row", "column", "color", "facet", "detail", "shape"]);
const MONTHS_LONG = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** Month index (0-11) for "Jan", "January", "Sept", etc.; -1 otherwise. */
export function monthIndex(value: unknown): number {
  if (typeof value !== "string") return -1;
  const v = value.trim().toLowerCase().replace(/\.$/, "");
  if (v.length < 3) return -1;
  return MONTHS_LONG.findIndex(m => m.startsWith(v) || (v === "sept" && m === "september"));
}
type FieldInfo = { numeric: Set<string>; months: Map<string, string[]>; years: Set<string> };

/** Field profiles used to fix encodings: month-name fields (calendar order) and integer-year fields. */
export function profileFields(data: VegaChart["data"], numeric: Set<string>): FieldInfo {
  const months = new Map<string, string[]>();
  const years = new Set<string>();
  const fields = Array.from(new Set(data.flatMap(row => Object.keys(row))));
  for (const f of fields) {
    const vals = data.map(r => (r as Record<string, unknown>)[f]).filter(v => v !== null && v !== undefined && v !== "");
    if (!vals.length) continue;
    if (vals.every(v => monthIndex(v) >= 0)) {
      const distinct = Array.from(new Set(vals as string[]));
      months.set(f, distinct.sort((a, b) => monthIndex(a) - monthIndex(b)));
    } else if (numeric.has(f) && vals.every(v => Number.isInteger(Number(v)) && Number(v) >= 1900 && Number(v) <= 2100)
      && (/year|season|yr/i.test(f) || vals.length <= 30)) {
      years.add(f);
    }
  }
  return { numeric, months, years };
}

function fixEncodings(node: unknown, info: FieldInfo | Set<string>): unknown {
  const fi: FieldInfo = info instanceof Set ? { numeric: info, months: new Map(), years: new Set() } : info;
  if (Array.isArray(node)) return node.map(n => fixEncodings(n, fi));
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "encoding" && v && typeof v === "object") {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, any>).map(([ch, enc]) => {
        if (!enc || typeof enc !== "object" || Array.isArray(enc) || typeof enc.field !== "string") return [ch, fixEncodings(enc, fi)];
        if (MEASURE_CHANNELS.has(ch) && fi.numeric.has(enc.field) && (enc.type === "ordinal" || enc.type === "nominal" || !enc.type)) {
          return [ch, { ...enc, type: "quantitative" }];
        }
        const order = fi.months.get(enc.field);
        if (order && CATEGORY_CHANNELS.has(ch)) {
          // Month names are categories in calendar order. An explicit array sort
          // from the spec is kept; "ascending"/"descending"/missing would be alphabetical.
          const keep = Array.isArray(enc.sort) || (enc.sort && typeof enc.sort === "object") || (typeof enc.sort === "string" && !/^(ascending|descending)$/.test(enc.sort));
          const sort = keep ? enc.sort : enc.sort === "descending" ? [...order].reverse() : order;
          const type = enc.type === "temporal" || enc.type === "quantitative" || !enc.type ? "ordinal" : enc.type;
          const { timeUnit: _tu, ...rest } = enc;
          return [ch, { ...rest, type, sort }];
        }
        if (fi.years.has(enc.field) && (ch === "x" || ch === "y") && (enc.type === "quantitative" || !enc.type)) {
          const axis = enc.axis === null ? null : { tickMinStep: 1, format: "d", ...(enc.axis ?? {}) };
          return [ch, { ...enc, type: "quantitative", axis, scale: { zero: false, ...(enc.scale ?? {}) } }];
        }
        if (ch === "x" && (enc.type === "nominal" || enc.type === "ordinal") && enc.axis && typeof enc.axis === "object" && "labelOverlap" in enc.axis) {
          // Specs that ask for labelOverlap hide every other category label (waterfalls).
          const { labelOverlap: _lo, ...axis } = enc.axis;
          return [ch, fixEncodings({ ...enc, axis }, fi)];
        }
        return [ch, fixEncodings(enc, fi)];
      }));
    } else out[k] = fixEncodings(v, fi);
  }
  return out;
}

/** Sparse single-view line/point charts get value labels so a handful of points read without hovering. */
function addSparseLabels(spec: Record<string, unknown>, rows: number): Record<string, unknown> {
  const mark = typeof spec.mark === "string" ? spec.mark : (spec.mark as any)?.type;
  const enc = spec.encoding as Record<string, any> | undefined;
  if (rows > 12 || !enc || !["line", "point"].includes(mark) || "layer" in spec) return spec;
  const y = enc.y;
  if (!y || typeof y.field !== "string" || y.type !== "quantitative" || y.aggregate) return spec;
  const { mark: m, encoding, ...rest } = spec;
  const textEnc: Record<string, unknown> = { x: enc.x, y, text: { field: y.field, type: "quantitative", format: ",.0f" } };
  if (enc.color) textEnc.color = enc.color;
  return { ...rest, layer: [{ mark: m, encoding }, { mark: { type: "text", dy: -10, fontSize: 11, fontWeight: 600 }, encoding: textEnc }] };
}

/** FarmFriend premium look (theme "farmfriend", emitted only when FF_PREMIUM_CHARTS prompts are on). */
function farmFriendConfig(width: number, hconcat: number) {
  const ink = "#1F2E2A", muted = "#62716B", grid = "#E6E1D6";
  return {
    background: "#FBF8F2", padding: { left: 12, right: 16, top: 10, bottom: 10 },
    font: "Inter, system-ui, sans-serif",
    view: { stroke: null, continuousWidth: Math.max(180, width / hconcat - 80), continuousHeight: 240 },
    range: { category: [...visualThemes.farmfriend], heatmap: ["#F4EED9", "#CFE3B4", "#8FC27A", "#4E9A5C", "#22663F", "#0F3D27"], ramp: ["#F4EED9", "#8FC27A", "#22663F"] },
    axis: { labelOverlap: true, labelLimit: 140, labelColor: muted, titleColor: muted, labelFontSize: 11.5, titleFontSize: 11.5, titleFontWeight: 600, gridColor: grid, gridDash: [3, 3], domain: false, tickColor: grid, labelPadding: 6, titlePadding: 10 },
    axisX: { grid: false, domain: true, domainColor: "#CFC8B8", labelFontSize: 12.5 },
    // Category x labels: never drop alternate labels; angle + wrap-friendly limit instead.
    axisXDiscrete: { labelOverlap: false, labelAngle: -35, labelAlign: "right", labelBaseline: "middle", labelLimit: 160, labelFontSize: 12.5 },
    legend: { orient: "top", direction: "horizontal", titleLimit: 400, labelLimit: 260, titleOrient: "top", labelColor: ink, labelFontSize: 12, titleFontSize: 11, titleColor: muted, symbolType: "circle", symbolSize: 110, columnPadding: 14 },
    header: { labelFontSize: 13, labelFontWeight: 700, labelColor: ink },
    title: { anchor: "start", fontSize: 17, fontWeight: 700, color: ink, subtitleColor: muted },
    area: { line: { strokeWidth: 2 }, interpolate: "monotone" },
    line: { strokeWidth: 2.6, strokeCap: "round" },
    bar: { cornerRadiusEnd: 3 },
    point: { filled: true, size: 70 },
    text: { color: ink, fontSize: 11 },
  };
}

export function themedVegaSpec(chart: VegaChart, width = 600): Record<string, unknown> {
  const normalized = normalizeChartData(chart);
  const info = profileFields(normalized.data, normalized.numeric);
  chart = { ...chart, data: normalized.data, spec: fixEncodings(chart.spec, info) as VegaChart["spec"] };
  const { config: _config, $schema: _schema, ...rawSpec } = chart.spec;
  const composed = ["facet", "repeat", "concat", "hconcat", "vconcat"].some(key => key in rawSpec);
  const spec = dedupeConstantTextLayers(composed ? rawSpec : addSparseLabels(rawSpec, chart.data.length));
  return {
    ...spec,
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { values: chart.data },
    ...(composed ? {} : { width: Math.max(180, width - 70), height: 320 }),
    autosize: { type: "fit", contains: "padding" },
    config: chart.theme === "farmfriend" ? farmFriendConfig(width, Array.isArray(spec.hconcat) ? spec.hconcat.length : 1) : {
      background: "transparent",
      font: "system-ui, sans-serif",
      view: { stroke: null, continuousWidth: Math.max(180, width / (Array.isArray(spec.hconcat) ? spec.hconcat.length : 1) - 80), continuousHeight: 240 },
      range: { category: [...visualThemes[chart.theme]] },
      axis: { labelOverlap: true, labelLimit: 140, labelFontSize: 12, titleFontSize: 12, titlePadding: 14, labelPadding: 8, labelColor: "#525b64", titleColor: "#354153", domain: false, tickSize: 0, gridColor: "#e8ecea", gridOpacity: 0.7 },
      axisX: { labelAngle: -30, labelAlign: "right", labelFontSize: 12.5 },
      axisXDiscrete: { labelOverlap: false, labelAngle: -35, labelAlign: "right", labelBaseline: "middle", labelLimit: 160, labelFontSize: 12.5 },
      legend: { orient: "bottom", titleLimit: 400, labelLimit: 260, labelFontSize: 12, titleFontSize: 12, padding: 12 },
      area: { opacity: 0.55 },
      line: { strokeWidth: 2.5 },
      point: { filled: true, size: 55 },
      title: { anchor: "start", fontSize: 16, color: "#253b36" },
    },
  };
}

// ---------- Gate C r3 helpers ----------

const POSITION_FIELD_CHANNELS = ["x", "y", "theta", "x2", "y2", "color", "size", "radius"];

/**
 * True when the spec would draw at least one series: every positional field it
 * encodes exists in the rows (or is produced by a transform `as`), and at least
 * one quantitative field has a finite number. Composite specs (repeat/facet/
 * concat) are trusted. An empty plot (axes, no marks) fails this check.
 */
export function chartHasPlottableSeries(chart: Pick<VegaChart, "data" | "spec">): boolean {
  const spec = chart.spec as Record<string, unknown>;
  if (["repeat", "facet", "concat", "hconcat", "vconcat"].some(k => k in spec)) return true;
  const keys = new Set(chart.data.flatMap(row => Object.keys(row)));
  const produced = new Set<string>();
  const fields: Array<{ field: string; type?: string; aggregate?: unknown }> = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, any>;
    if (Array.isArray(obj.transform)) {
      for (const t of obj.transform) {
        if (!t || typeof t !== "object") continue;
        for (const v of [t.as].flat()) if (typeof v === "string") produced.add(v);
        for (const arr of [t.aggregate, t.window, t.joinaggregate]) if (Array.isArray(arr)) for (const a of arr) if (typeof a?.as === "string") produced.add(a.as);
        if (t.fold) { produced.add("key"); produced.add("value"); }
      }
    }
    if (obj.encoding && typeof obj.encoding === "object") {
      for (const ch of POSITION_FIELD_CHANNELS) {
        const enc = obj.encoding[ch];
        if (enc && typeof enc === "object" && typeof enc.field === "string") fields.push({ field: enc.field.split(".")[0], type: enc.type, aggregate: enc.aggregate });
      }
    }
    if (obj.layer) walk(obj.layer);
  };
  walk(spec);
  if (!fields.length) return false;
  const known = (f: string) => keys.has(f) || produced.has(f);
  if (!fields.every(f => known(f.field))) return false;
  const quantitative = fields.filter(f => f.type === "quantitative" && keys.has(f.field));
  if (quantitative.length) {
    return quantitative.some(f => chart.data.some(row => {
      const v = (row as Record<string, unknown>)[f.field];
      return (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && NUMERIC_STRING.test(v));
    }));
  }
  return true;
}

/** "12-month average" style labels: a constant text layer would repeat once per row; draw it once. */
export function dedupeConstantTextLayers(spec: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(spec.layer)) return spec;
  const layer = (spec.layer as Array<Record<string, any>>).map(l => {
    const mark = typeof l?.mark === "string" ? l.mark : l?.mark?.type;
    const enc = l?.encoding ?? {};
    const constantY = enc.y && (enc.y.datum !== undefined || enc.y.value !== undefined);
    const constantText = (l?.mark && typeof l.mark === "object" && typeof l.mark.text === "string") || (enc.text && (enc.text.datum !== undefined || enc.text.value !== undefined));
    if (mark !== "text" || !constantY || !constantText) return l;
    const transform = Array.isArray(l.transform) ? l.transform : [];
    if (transform.some((t: any) => t?.filter === "datum.__ff_rn === 1")) return l;
    return { ...l, transform: [...transform, { window: [{ op: "row_number", as: "__ff_rn" }] }, { filter: "datum.__ff_rn === 1" }] };
  });
  return { ...spec, layer };
}

/** True when the farmer explicitly asked for a second / dual / right y-axis. */
export function asksForDualAxis(text: string | undefined): boolean {
  return !!text && /\b(dual|secondary|second|two|twin|right[- ]hand|right)\s+(y[- ]?)?ax(is|es)\b|\bdual[- ]axis\b|\btwo y\b/i.test(text);
}

/** Removes independent y scales/axes and right-oriented y axes (no dual axis unless asked). */
export function stripDualAxis(spec: Record<string, unknown>): Record<string, unknown> {
  // Small multiples legitimately need per-panel y scales (units differ); that is not a dual axis.
  if (isFacetedSpec(spec)) return spec;
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "resolve" && v && typeof v === "object") {
        const r = JSON.parse(JSON.stringify(v));
        if (r.scale) delete r.scale.y;
        if (r.axis) delete r.axis.y;
        if (r.scale && !Object.keys(r.scale).length) delete r.scale;
        if (r.axis && !Object.keys(r.axis).length) delete r.axis;
        if (Object.keys(r).length) out[k] = r;
        continue;
      }
      if (k === "y" && v && typeof v === "object" && (v as any).axis && typeof (v as any).axis === "object" && (v as any).axis.orient === "right") {
        const { orient: _o, ...axis } = (v as any).axis;
        out[k] = { ...(v as object), axis };
        continue;
      }
      out[k] = strip(v);
    }
    return out;
  };
  return strip(spec) as Record<string, unknown>;
}

const OUT_OF_REGION_DOMAINS = /(^|\.)(iastate\.edu|purdue\.edu|illinois\.edu|umn\.edu|unl\.edu|k-state\.edu|ksu\.edu|osu\.edu|psu\.edu|cornell\.edu|wisc\.edu|msu\.edu|uky\.edu|ufl\.edu|tamu\.edu|uga\.edu|ncsu\.edu|missouri\.edu|ohio-state\.edu|montana\.edu|ndsu\.edu|sdstate\.edu|umd\.edu|vt\.edu|clemson\.edu|auburn\.edu|lsu\.edu|okstate\.edu|arkansas\.edu|uark\.edu|iowa\.gov|purdue\.extension\.org)$/i;
const LOW_QUALITY_DOMAINS = /(^|\.)(shuncy\.com|gardeningknowhow\.com|thespruce\.com|wikihow\.com|hunker\.com|homesandgardens\.com|reddit\.com|quora\.com|pinterest\.com|cropple\.ai|farmhq\.com|gardenerspath\.com|plantcaretoday\.com|bloomingbackyard\.com|ehow\.com)$/i;
const PNW_QUESTION = /\b(oregon|willamette|eugene|corvallis|salem|portland|pacific northwest|pnw|western oregon|washington state|idaho)\b/i;
const OTHER_STATE_PATH = /\b(iowa|illinois|indiana|nebraska|kansas|minnesota|montana|dakota|missouri|ohio|kentucky|texas|georgia|florida|alabama|arkansas)\b/i;
const MIDWEST_CROP = /\b(corn|soybeans?|maize)\b/i;

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

/**
 * Drops cited URLs that don't fit the question: low-quality content farms always,
 * and out-of-region extension pages (Iowa, Purdue…) for a Pacific-Northwest
 * question, unless the page is about a crop the farmer named. Regional sources
 * (oregonstate.edu, wsu.edu, uidaho.edu, usda.gov) sort first.
 */
export function filterRelevantSources(sources: string[], questionText: string | undefined): string[] {
  const q = questionText ?? "";
  const pnw = PNW_QUESTION.test(q);
  const askedMidwestCrop = MIDWEST_CROP.test(q);
  const kept = sources.filter(s => {
    if (!/^https?:\/\//i.test(s)) return true;
    const host = hostOf(s);
    if (LOW_QUALITY_DOMAINS.test(host)) return false;
    if (pnw && OUT_OF_REGION_DOMAINS.test(host)) return false;
    if (pnw && !askedMidwestCrop && MIDWEST_CROP.test(s)) return false;
    if (pnw && OTHER_STATE_PATH.test(s) && !OTHER_STATE_PATH.test(q)) return false;
    return true;
  });
  return kept.map((s, i) => [s, i] as const).sort((a, b) => rankSource(a[0], q) - rankSource(b[0], q) || a[1] - b[1]).map(([s]) => s);
}

const FIELD_CROP_QUESTION = /\b(field|acres?|ac\b|farm|grass seed|fescue|ryegrass|wheat|barley|oats|hay|alfalfa|clover|hazelnuts?|filberts?|corn|soybeans?|canola|meadowfoam|hops|mint|row crops?|cover crops?|pasture|tons?\/ac|lb\/ac|bu\/ac)\b/i;
const HOME_GARDEN_URL = /(garden(ing)?[-_/]|home[-_]?garden|master[-_]?gardener|vegetable[-_]garden|backyard|yard[-_]and[-_]garden|monthly[-_]garden|garden[-_]calendar|\/gardening\b|\/garden\b)/i;
const FIELD_CROP_URL = /(crop[-_]production|field[-_]crops?|cropandsoil|agsci|grass[-_]seed|seed[-_]crops|hazelnut|wheat|cereal|forage|catalog\/(?:em|pnw|ec)[-_]?\d)/i;

/**
 * Lower is better. OSU first; for field-crop questions OSU / regional crop-
 * production and field-crop guides outrank home-garden calendars.
 */
export function rankSource(url: string, questionText?: string): number {
  if (!/^https?:/i.test(url)) return 4;
  const h = hostOf(url);
  const fieldCrop = FIELD_CROP_QUESTION.test(questionText ?? "");
  let r = /oregonstate\.edu$/.test(h) ? 0 : /(wsu\.edu|uidaho\.edu|usda\.gov|\.gov)$/.test(h) ? 1 : 2;
  if (fieldCrop) {
    if (HOME_GARDEN_URL.test(url)) r += 2.5;
    else if (FIELD_CROP_URL.test(url)) r -= 0.5;
  }
  return r;
}

/** Footer: "assumptions" only when no real source remains. */
export function tidySourceList(sources: string[]): string[] {
  const isAssumption = (s: string) => /^(assumptions?|illustrative)$/i.test(s.trim());
  const real = sources.filter(s => !isAssumption(s));
  return real.length ? Array.from(new Set(real)) : sources.length ? ["assumptions"] : [];
}

/** Faceted (small-multiples) spec: top-level facet, or row/column/facet encodings. */
export function isFacetedSpec(spec: Record<string, unknown>): boolean {
  if ("facet" in spec) return true;
  const enc = (spec.encoding ?? {}) as Record<string, unknown>;
  return ["row", "column", "facet"].some(k => k in enc);
}

function facetField(spec: Record<string, any>): string | undefined {
  if (spec.facet) return spec.facet.field ?? spec.facet.row?.field ?? spec.facet.column?.field;
  const enc = spec.encoding ?? {};
  return enc.facet?.field ?? enc.column?.field ?? enc.row?.field;
}

function yField(spec: Record<string, any>): string | undefined {
  const inner = spec.spec ?? spec;
  if (inner.encoding?.y?.field) return inner.encoding.y.field;
  for (const l of inner.layer ?? []) if (l?.encoding?.y?.field) return l.encoding.y.field;
  return undefined;
}

const UNIT_RE = /\(([^)]*\/[^)]*)\)|\b(tons?\/ac|lb\/ac|lbs\/ac|bu\/ac|kg\/ha|t\/ha|cwt\/ac)\b/i;

/**
 * Small multiples whose panels carry different units (tons/ac vs lb/ac) or
 * magnitudes (>10x) get independent y scales, and the caption is made to match
 * what is drawn.
 */
export function asksForSmallMultiples(text: string): boolean {
  return /\b(small[ -]multiples?|facet(ed|s)?|one (panel|chart|mini[ -]chart) (per|for each)|panel per|side[- ]by[- ]side panels|trellis)\b/i.test(text ?? "");
}

/**
 * When the farmer explicitly asked for small multiples but the model returned a
 * single view with a nominal colour/series field, wrap it in a column facet on
 * that field (one panel per series). Non-matching specs are returned unchanged.
 */
export function ensureFacetWhenAsked(spec: Record<string, unknown>, farmerText: string): Record<string, unknown> {
  const s = spec as Record<string, any>;
  if (!asksForSmallMultiples(farmerText) || isFacetedSpec(s)) return spec;
  if (s.layer || s.hconcat || s.vconcat || s.concat || s.repeat || !s.encoding) return spec;
  const enc = s.encoding as Record<string, any>;
  const series = [enc.color, enc.column, enc.row, enc.xOffset, enc.detail].find(c => c && typeof c.field === "string" && (c.type === "nominal" || c.type === "ordinal"));
  if (!series) return spec;
  const { width: _w, height: _h, ...inner } = s;
  return { facet: { field: series.field, type: "nominal", title: null }, columns: 2, spec: { ...inner, width: 220, height: 140 } };
}

export function applyFacetScales(chart: { data: Record<string, unknown>[]; spec: Record<string, unknown>; description?: string }): { spec: Record<string, unknown>; description?: string } {
  const spec = chart.spec as Record<string, any>;
  if (!isFacetedSpec(spec)) return { spec, description: chart.description };
  const ff = facetField(spec);
  const yf = yField(spec);
  let independent = spec.resolve?.scale?.y === "independent";
  if (!independent && ff && yf) {
    const groups = new Map<string, number[]>();
    for (const row of chart.data) {
      const v = Number(row[yf]);
      if (!Number.isFinite(v)) continue;
      const k = String(row[ff]);
      groups.set(k, [...(groups.get(k) ?? []), Math.abs(v)]);
    }
    const units = new Set(Array.from(groups.keys()).map(k => (k.match(UNIT_RE)?.[0] ?? "").toLowerCase()).filter(Boolean));
    const unitField = Object.keys(chart.data[0] ?? {}).find(k => /^units?$/i.test(k));
    if (unitField) for (const r of chart.data) units.add(String(r[unitField]).toLowerCase());
    const maxes = Array.from(groups.values()).map(v => Math.max(...v)).filter(m => m > 0);
    const spread = maxes.length > 1 ? Math.max(...maxes) / Math.min(...maxes) : 1;
    independent = units.size > 1 || spread > 10;
  }
  let description = chart.description;
  if (independent) {
    const out = { ...spec, resolve: { ...(spec.resolve ?? {}), scale: { ...(spec.resolve?.scale ?? {}), y: "independent" } } };
    if (description && /(same|shared|common|single) (y[- ]?)?(axis|scale)/i.test(description)) description = description.replace(/[^.]*\b(same|shared|common|single) (y[- ]?)?(axis|scale)[^.]*\.?\s*/gi, "").trim();
    if (!description || !/independent|own (y[- ]?)?(axis|scale)/i.test(description)) description = `${description ? description + " " : ""}Each panel has its own y-axis scale; compare shapes, not bar heights, across panels.`;
    return { spec: out, description };
  }
  if (description && /independent (y[- ]?)?(axis|axes|scales?)|own (y[- ]?)?(axis|scale)/i.test(description)) description = description.replace(/[^.]*\b(independent|own) (y[- ]?)?(axis|axes|scales?)[^.]*\.?\s*/gi, "").trim() + " All panels share one y-axis scale.";
  return { spec, description };
}

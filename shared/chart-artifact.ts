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
  const spec = composed ? rawSpec : addSparseLabels(rawSpec, chart.data.length);
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

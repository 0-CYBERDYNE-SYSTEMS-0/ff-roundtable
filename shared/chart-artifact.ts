import { z } from "zod";

export const visualThemes = {
  earth: ["#276354", "#447b9d", "#b77835", "#866394", "#6c7837", "#bd6262"],
  ocean: ["#216582", "#487e70", "#a66b40", "#77609c", "#a64f68", "#687337"],
  ink: ["#35465e", "#9b6336", "#457c76", "#886487", "#7e792f", "#ae5760"],
} as const;

export const vegaChartSchema = z.object({
  type: z.literal("vega-lite"),
  title: z.string().trim().min(1).max(180),
  description: z.string().max(1200).optional(),
  theme: z.enum(["earth", "ocean", "ink"]).default("earth"),
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
export function themedVegaSpec(chart: VegaChart, width = 600): Record<string, unknown> {
  const { config: _config, $schema: _schema, ...spec } = chart.spec;
  const composed = ["facet", "repeat", "concat", "hconcat", "vconcat"].some(key => key in spec);
  return {
    ...spec,
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { values: chart.data },
    ...(composed ? {} : { width: Math.max(180, width - 70), height: 320 }),
    config: {
      background: "transparent",
      font: "system-ui, sans-serif",
      view: { stroke: null, continuousWidth: Math.max(180, width / (Array.isArray(spec.hconcat) ? spec.hconcat.length : 1) - 80), continuousHeight: 240 },
      range: { category: [...visualThemes[chart.theme]] },
      axis: { labelFontSize: 12, titleFontSize: 12, titlePadding: 14, labelPadding: 8, labelColor: "#525b64", titleColor: "#354153", domain: false, tickSize: 0, gridColor: "#e8ecea", gridOpacity: 0.7 },
      legend: { orient: "bottom", labelFontSize: 12, titleFontSize: 12, padding: 12 },
      area: { opacity: 0.55 },
      line: { strokeWidth: 2.5 },
      point: { filled: true, size: 55 },
      title: { anchor: "start", fontSize: 16, color: "#253b36" },
    },
  };
}

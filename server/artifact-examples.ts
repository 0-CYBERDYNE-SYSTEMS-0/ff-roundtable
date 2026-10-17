// Training inputs are explicitly separate from the farmer's actual evidence.
export const artifactExamples = [
  {
    request: "Farmer supplies crop water use in mm: April corn 18, beans 12; May corn 25, beans 19. Compare seasonal patterns.",
    output: {
      type: "vega-lite", title: "Crop water use · April–May", theme: "earth", sources: ["farmer"],
      description: "Both crops rise from April to May. These are the supplied values; two months do not establish a full-season trend.",
      data: [{ date: "2026-04-01", crop: "Corn", mm: 18 }, { date: "2026-04-01", crop: "Beans", mm: 12 }, { date: "2026-05-01", crop: "Corn", mm: 25 }, { date: "2026-05-01", crop: "Beans", mm: 19 }],
      spec: {
        mark: { type: "area", line: true },
        params: [{ name: "crop", select: { type: "point", fields: ["crop"] }, bind: "legend" }],
        encoding: { x: { field: "date", type: "temporal", title: "Month", axis: { format: "%b" } }, y: { field: "mm", type: "quantitative", title: "Water use (mm)", stack: null }, color: { field: "crop", type: "nominal" }, opacity: { condition: { param: "crop", value: 0.55 }, value: 0.12 }, tooltip: [{ field: "crop" }, { field: "date", type: "temporal" }, { field: "mm", type: "quantitative", title: "Water use (mm)" }] },
      },
    },
  },
  {
    request: "Farmer supplies soil moisture (%): north April 20, May 25; south April 16, May 19. Compare fields over time.",
    output: {
      type: "vega-lite", title: "Soil moisture by field · April–May", theme: "ocean", sources: ["farmer"],
      description: "South has lower supplied moisture in both months. Missing dates are unobserved, not zero; these values alone do not justify an irrigation threshold.",
      data: [{ month: "April", field: "North", moisture: 20 }, { month: "May", field: "North", moisture: 25 }, { month: "April", field: "South", moisture: 16 }, { month: "May", field: "South", moisture: 19 }],
      spec: { mark: { type: "rect", tooltip: true }, encoding: { x: { field: "month", type: "ordinal", sort: ["April", "May"], title: "Month" }, y: { field: "field", type: "nominal", title: "Field" }, color: { field: "moisture", type: "quantitative", title: "Moisture (%)", scale: { scheme: "tealblues", zero: true } }, tooltip: [{ field: "field" }, { field: "month" }, { field: "moisture", title: "Moisture (%)" }] } },
    },
  },
  {
    request: "Farmer supplies April/May rainfall of 12/18 mm and soil moisture of 20/23%. Show both without suggesting equal units.",
    output: {
      type: "vega-lite", title: "Rainfall and soil moisture · April–May", theme: "ocean", sources: ["farmer"],
      description: "Separate aligned panels preserve units. Both supplied values rise, but this does not establish causation.",
      data: [{ date: "2026-04-01", rain: 12, moisture: 20 }, { date: "2026-05-01", rain: 18, moisture: 23 }],
      spec: { vconcat: [
        { mark: { type: "bar", tooltip: true }, encoding: { x: { field: "date", type: "temporal", title: "Month" }, y: { field: "rain", type: "quantitative", title: "Rainfall (mm)" } } },
        { mark: { type: "line", point: true, tooltip: true }, encoding: { x: { field: "date", type: "temporal", title: "Month" }, y: { field: "moisture", type: "quantitative", title: "Soil moisture (%)" } } },
      ], resolve: { scale: { x: "shared" } } },
    },
  },
  {
    request: "Farmer supplies quoted equipment costs: repair $1200, used $3500, new $6200. Compare upfront cost only.",
    output: {
      type: "vega-lite", title: "Equipment options · quoted upfront cost", theme: "ink", sources: ["farmer"],
      description: "Repair has the lowest quoted upfront cost. Operating costs, useful life and reliability are not provided, so this is not a total-cost recommendation.",
      data: [{ option: "Repair", usd: 1200 }, { option: "Used", usd: 3500 }, { option: "New", usd: 6200 }],
      spec: { layer: [
        { mark: { type: "point", filled: true, size: 100 } },
        { mark: { type: "text", align: "left", dx: 10 }, encoding: { text: { field: "usd", type: "quantitative", format: "$,.0f" } } },
      ], encoding: { y: { field: "option", type: "nominal", sort: { field: "usd" }, title: null }, x: { field: "usd", type: "quantitative", title: "Quoted upfront cost (USD)", scale: { zero: true } }, tooltip: [{ field: "option" }, { field: "usd", format: "$,.0f", title: "Quoted cost" }] } },
    },
  },
];

export function artifactExamplesForRequest(request: string): string {
  if (!/\b(chart|charts|visuali[sz]\w*|graph|graphs|plot|plots|dashboard|heatmap)\b/i.test(request)) return "";
  return "VISUAL DESIGN TRAINING EXAMPLES: The following farmer inputs are fictional training context, never evidence for this conversation. Use the designs as inspiration, not a fixed menu. Return chart JSON inside a chart fence.\n" +
    artifactExamples.map(example => `Example farmer input: ${example.request}\nExample chart output: ${JSON.stringify(example.output)}`).join("\n\n");
}

# FFRT premium charts: decision and plan (2026-10-24)

## Decision: hybrid. Vega-Lite is the primary engine, ECharts covers sankey and calendar only.
- **Vega-Lite (already shipped; we restyle it and allow richer specs).** It covers multi-area, stacked, streamgraph (stack:center), layered, dual-axis (resolve independent), faceted small multiples, heatmaps, regression, and maps (geoshape). Specs are declarative pure JSON, with no eval. In the LLM test, 9/9 specs rendered. The beauty gap is in our theme and our prompt, not in the engine. See before-after-multi-area.png.
- **ECharts, lazy-loaded only for the `sankey` and `calendar` kinds.** These are nicer and native in ECharts. Its specs are about 45% smaller (median of ~880 vs ~1,770 completion tokens), but MiniMax produced JS-style unquoted keys in 2/3 runs. The bundle is ~335 KB gz, versus ~262 KB gz for vega + vega-lite. ECharts has animation and tooltips out of the box. A JS formatter in a spec is a code-exec risk, so JSON-only must be enforced.
- **Rejected: the current recharts path** (only line/area/bar).

## Schema
```
{ "type":"chart", "engine":"vega-lite"|"echarts", "kind":"area|stacked-area|stream|layered|dual-axis|facet|heatmap|scatter|bar|diverging|sankey|calendar|map",
  "title", "subtitle", "sources":[...]|["assumptions"], "data":[...], "spec":{...} }
```
- The server injects the FarmFriend config/theme (shared/ff-chart-theme.ts). Models never write colours or fonts, which keeps specs short and the look consistent.
- A light/dark variant is chosen by swapping the config, not the spec.

## Validation, repair and fallback
1. Parse JSON. If that fails, strip fences and extract the outermost {}. If that fails, apply json5-style repairs (quote keys, drop trailing commas, remove comments).
2. Allowlist: reject any `function`, `expr`/`signal` strings outside a small safe set, external `url` data, and `usermeta`.
3. Compile and render on the server: Vega-Lite `compile` plus a vega View with renderer "none". For ECharts, use SSR `renderToSVGString` with a 500 ms timeout. If there are errors or the SVG is empty, go to the next step.
4. Retry once with the error message, at 1,500 max tokens on the same model.
5. Fallback: rebuild a plain themed chart from `data` and `kind` with the deterministic template, then a table.
6. Keep the existing source gating (`validateChartArtifactDetailed`, Illustrative label).

## Prompts
- Give each kind a short "kind → minimal spec skeleton" example, ~150 tokens each, and include only the kinds relevant to the request.
- Use a headline-style title (the insight), plus a subtitle with units, scope and source.
- Use ≤ 6 series, use long-format data, and keep numbers as numbers.

## Rendering
- Client: VegaChart gets the FF config, the vega-embed actions menu (PNG/SVG export), and tooltips. Add an EChartsChart.tsx via dynamic import() so that sankey/calendar alone pay the bundle cost.
- CSP: vega needs `'unsafe-eval'` unless we use the expression interpreter (`vega-interpreter`, `ast:true`). **Use the interpreter.** ECharts needs no eval.
- PNG export: vega `view.toImageURL('png', 2)` and ECharts `getDataURL({pixelRatio:2})`.

## Tests
- Snapshot-render each kind skeleton through the server validator.
- Fixture regression suite: the 18 saved LLM outputs (llm-results.json) must render or repair.
- Security: reject function, url, signal and eval payloads.
- Truncation: a cut-off spec triggers repair, then the fallback.
- Flag `FF_PREMIUM_CHARTS=1`, defaulting to off until QA.

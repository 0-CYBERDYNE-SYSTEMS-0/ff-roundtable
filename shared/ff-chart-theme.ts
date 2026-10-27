// FarmFriend premium chart theme (Vega-Lite config + ECharts theme share one palette)
export const FF = {
  palette: ["#2F7D4F", "#E0A526", "#3B82A6", "#B5653A", "#7BAF5A", "#8A6FB0", "#D9734E", "#5E8C8A"],
  ink: "#1F2E2A", muted: "#62716B", grid: "#E6E1D6", bg: "#FBF8F2", font: "Inter, 'DejaVu Sans', system-ui, sans-serif",
  seq: ["#F4EED9", "#CFE3B4", "#8FC27A", "#4E9A5C", "#22663F", "#0F3D27"],
};
export const vlConfig = {
  background: FF.bg, padding: { left: 16, right: 20, top: 14, bottom: 12 },
  font: FF.font,
  view: { stroke: null },
  range: { category: FF.palette, heatmap: FF.seq, ramp: FF.seq },
  title: { anchor: "start", fontSize: 19, fontWeight: 700, color: FF.ink, subtitleFontSize: 12.5, subtitleColor: FF.muted, subtitlePadding: 6, offset: 14 },
  axis: { labelColor: FF.muted, titleColor: FF.muted, labelFontSize: 11.5, titleFontSize: 11.5, titleFontWeight: 600, gridColor: FF.grid, gridDash: [3, 3], domain: false, tickColor: FF.grid, labelPadding: 6, titlePadding: 10 },
  axisX: { grid: false, domain: true, domainColor: "#CFC8B8" },
  legend: { orient: "top", direction: "horizontal", labelColor: FF.ink, labelFontSize: 12, titleFontSize: 11, titleColor: FF.muted, symbolType: "circle", symbolSize: 110, columnPadding: 14 },
  header: { labelFontSize: 13, labelFontWeight: 700, labelColor: FF.ink, titleFontSize: 0 },
  area: { line: { strokeWidth: 2 }, interpolate: "monotone" },
  line: { strokeWidth: 2.6, interpolate: "monotone", strokeCap: "round" },
  bar: { cornerRadiusTopLeft: 4, cornerRadiusTopRight: 4 },
  point: { filled: true, size: 70 },
};
export const echartsTheme = {
  color: FF.palette, backgroundColor: FF.bg, textStyle: { fontFamily: FF.font, color: FF.ink },
  title: { left: 16, top: 12, textStyle: { fontSize: 19, fontWeight: 700, color: FF.ink }, subtextStyle: { fontSize: 12.5, color: FF.muted } },
  legend: { top: 62, left: 16, icon: "circle", textStyle: { color: FF.ink } },
};

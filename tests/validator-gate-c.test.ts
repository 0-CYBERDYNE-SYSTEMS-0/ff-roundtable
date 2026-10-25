// Validator gate C on dev 5c17285 (2026-10-25): one regression per finding.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { compile, type TopLevelSpec } from "vega-lite";
import { themedVegaSpec, parseVegaChart, monthIndex } from "../shared/chart-artifact";
import { filterChartArtifacts, chartResearchUrls } from "../server/expert-tools";
import { extractArtifacts } from "../server/artifact-extractor";
import { parseChartJsonWithRepair } from "../server/chart-repair";
import { getFarmerFileIntent } from "../server/orchestrator";
import { markdownTableComponents } from "../client/src/components/chat/markdown-table";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep"];
const themed = (o: Record<string, unknown>) => themedVegaSpec(parseVegaChart({ type: "vega-lite", title: "t", theme: "farmfriend", sources: ["assumptions"], ...o })!) as any;
const enc = (spec: any) => spec.encoding ?? spec.layer?.[0]?.encoding;

describe("(1) month names sort in calendar order", () => {
  const data = MONTHS.flatMap(m => [{ month: m, pest: "SWD", idx: 10 }]);
  it("heatmap months: default/ascending sort becomes calendar order", () => {
    for (const sort of [undefined, "ascending"]) {
      const s = themed({ data, spec: { mark: "rect", encoding: { x: { field: "month", type: "nominal", ...(sort ? { sort } : {}) }, y: { field: "pest", type: "nominal" }, color: { field: "idx", type: "quantitative" } } } });
      expect(enc(s).x.sort).toEqual(MONTHS);
      expect(() => compile(s as TopLevelSpec)).not.toThrow();
    }
  });
  it("keeps an explicit array sort from the spec", () => {
    const s = themed({ data, spec: { mark: "bar", encoding: { x: { field: "month", type: "ordinal", sort: ["Sep", "Apr"] }, y: { field: "idx", type: "quantitative" } } } });
    expect(enc(s).x.sort).toEqual(["Sep", "Apr"]);
  });
  it("month names typed temporal (MiniMax harvest collapse) become ordinal, calendar sorted", () => {
    const s = themed({ data: [{ m: "July", t: 3 }, { m: "June", t: 1 }, { m: "August", t: 2 }], spec: { mark: "bar", encoding: { x: { field: "m", type: "temporal", timeUnit: "month" }, y: { field: "t", type: "quantitative" } } } });
    expect(enc(s).x).toMatchObject({ type: "ordinal", sort: ["June", "July", "August"] });
    expect(enc(s).x.timeUnit).toBeUndefined();
  });
  it("monthIndex handles abbreviations", () => {
    expect([monthIndex("Sept"), monthIndex("jan."), monthIndex("Ma"), monthIndex("Foo")]).toEqual([8, 0, -1, -1]);
  });
});

describe("(2)(10) category x labels: none skipped, larger font; (3) legend titles not truncated", () => {
  const s = themed({ data: [{ step: "Gross revenue", v: 6500 }, { step: "Harvest", v: -900 }], spec: { mark: "bar", encoding: { x: { field: "step", type: "nominal", axis: { labelOverlap: true, labelAngle: -30 } }, y: { field: "v", type: "quantitative" } } } });
  it("drops spec labelOverlap on discrete x and config disables it", () => {
    expect(enc(s).x.axis.labelOverlap).toBeUndefined();
    expect(enc(s).x.axis.labelAngle).toBe(-30);
    expect(s.config.axisXDiscrete).toMatchObject({ labelOverlap: false });
    expect(s.config.axisXDiscrete.labelFontSize).toBeGreaterThanOrEqual(12.5);
    expect(s.config.axisX.labelFontSize).toBeGreaterThanOrEqual(12.5);
  });
  it("legend titleLimit is wide", () => {
    expect(s.config.legend.titleLimit).toBeGreaterThanOrEqual(400);
    const earth = themedVegaSpec(parseVegaChart({ type: "vega-lite", title: "t", sources: ["farmer"], data: [{ a: "x", b: 1 }], spec: { mark: "bar", encoding: { x: { field: "a" }, y: { field: "b" } } } })!) as any;
    expect(earth.config.legend.titleLimit).toBeGreaterThanOrEqual(400);
    expect(earth.config.axisXDiscrete.labelOverlap).toBe(false);
  });
  it("verdict table is full width so Position wraps (no w-max scroll)", () => {
    const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], components: markdownTableComponents }, "| Expert | Position |\n|---|---|\n| Specialist | conditional |"));
    expect(html).toContain('class="w-full border-separate');
    expect(html).not.toContain("w-max");
  });
});

describe("(7) yearly series: integer ticks and sparse data labels", () => {
  const s = themed({ data: [2026, 2027, 2028, 2029, 2030].map((year, i) => ({ year, revenue: 40000 + i * 5000 })), spec: { mark: { type: "line", point: true }, encoding: { x: { field: "year", type: "quantitative" }, y: { field: "revenue", type: "quantitative" } } } });
  it("x axis uses tickMinStep 1 and format d", () => {
    expect(enc(s).x.axis).toMatchObject({ tickMinStep: 1, format: "d" });
  });
  it("adds a text layer for sparse points and still compiles", () => {
    expect(s.layer).toHaveLength(2);
    expect(s.layer[1].mark.type).toBe("text");
    expect(() => compile(s as TopLevelSpec)).not.toThrow();
  });
});

describe("(4)(11) footer uses real research citations", () => {
  const url = "https://agsci.oregonstate.edu/em8538";
  const chart = (o: Record<string, unknown>) => "```chart\n" + JSON.stringify({ type: "vega-lite", title: "Illustrative: pest pressure by month", theme: "earth", data: [{ m: "Jun", v: 5 }], spec: { mark: "bar", encoding: { x: { field: "m", type: "nominal" }, y: { field: "v", type: "quantitative" } } }, ...o }) + "\n```";
  it("assumptions-only chart gets the cited research URL prepended", () => {
    const r = filterChartArtifacts(extractArtifacts(chart({ sources: ["assumptions"] })).artifacts, [url], { researchUrls: [url] });
    expect(JSON.parse(r.kept[0].content).sources).toEqual([url, "assumptions"]);
  });
  it("chartResearchUrls prefers cited ids, falls back to all fetched", () => {
    const srcs = [{ id: "S1", url }, { id: "S2", url: "https://x.example/b" }];
    expect(chartResearchUrls("per OSU [S1]", srcs)).toEqual([url]);
    expect(chartResearchUrls("no ids", srcs)).toEqual([url, "https://x.example/b"]);
  });
});

describe("(8) first-attempt chart JSON repairs", () => {
  it("thousands separators, arithmetic, single quotes, smart quotes, missing commas", () => {
    const raw = "{'title': \u201CMargin\u201D, \"data\": [{\"step\": \"Labor\", \"v\": 1,800}\n{\"step\": \"Net\", \"v\": 6500 - 6300}]}";
    const out = parseChartJsonWithRepair(raw).value as any;
    expect(out.title).toBe("Margin");
    expect(out.data).toEqual([{ step: "Labor", v: 1800 }, { step: "Net", v: 200 }]);
  });
  describe("premium source variants", () => {
    const prev = process.env.FF_PREMIUM_CHARTS;
    beforeEach(() => { process.env.FF_PREMIUM_CHARTS = "1"; });
    afterEach(() => { if (prev === undefined) delete process.env.FF_PREMIUM_CHARTS; else process.env.FF_PREMIUM_CHARTS = prev; });
    it("maps a URL variant to the fetched URL and drops title-only labels", () => {
      const url = "https://extension.oregonstate.edu/hazelnuts";
      const text = "```chart\n" + JSON.stringify({ type: "vega-lite", title: "Hazelnut yield by year, Oregon", data: [{ y: "2024", v: 1 }], sources: ["http://www.extension.oregonstate.edu/hazelnuts/", "OSU EM 8538"], spec: { mark: "bar", encoding: { x: { field: "y", type: "ordinal" }, y: { field: "v", type: "quantitative" } } } }) + "\n```";
      const r = filterChartArtifacts(extractArtifacts(text).artifacts, [url]);
      expect(r.kept).toHaveLength(1);
      expect(JSON.parse(r.kept[0].content).sources).toEqual([url]);
    });
  });
});

describe("(5) table + calendar request is generation, not retrieval", () => {
  it("indefinite requests are not retrieval", () => {
    expect(getFarmerFileIntent("Give me a table of field tasks plus a calendar of when to do them this spring.")).toBeNull();
    expect(getFarmerFileIntent("Send me a new spray calendar")).toBeNull();
  });
  it("saved/link requests still retrieve", () => {
    expect(getFarmerFileIntent("Give me the saved calendar")).toBe("retrieve");
    expect(getFarmerFileIntent("give me a link to the calendar")).toBe("retrieve");
  });
});

describe("(6)(9) client guards", () => {
  it("no sends while a new roundtable is being created", () => {
    const src = readFileSync("client/src/pages/home-page.tsx", "utf8");
    expect(src).toMatch(/handleSendMessage = [^]*?if \(createConversationMutation\.isPending\) return;/);
    expect(src).toContain("createConversationMutation.isPending || isProcessing");
  });
  it("vite HMR on Replit uses clientPort 443", () => {
    expect(readFileSync("server/vite.ts", "utf8")).toContain("{ server, clientPort: 443 }");
  });
});

// Validator gate C r7 on dev 1dc410f (2026-10-25).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { spawn, type ChildProcess } from "child_process";
import WebSocket from "ws";
import { runToolCalls, formatToolResultsForPrompt, FROST_FALLBACK_CALLS } from "../server/expert-tools";
import { buildInlineCalendarArtifact, findConversationAnchor, findPersistedCalendarAnchor, afterLastFrost, notesWithoutTitle, calendarDisplayName, finalizeCalendarEvents } from "../shared/schedule-extract";
import { parseInlineCalendar } from "../shared/inline-calendar";
import { readableSourceTitle } from "../shared/chart-artifact";

const TODAY = "2026-10-25";
const html = (t: string, body: string) => new Response(`<html><title>${t}</title><body>${body}</body></html>`, { headers: { "content-type": "text/html" } });

describe("(1) frost/climate answers lead with OSU, USDA or NOAA", () => {
  it("only Almanac.com found → targeted follow-up fetches an authoritative source, ranked S1", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (u: string) => {
      seen.push(u);
      if (u.includes("duckduckgo")) return html("s", "");
      if (u.includes("almanac")) return html("Frost Dates Eugene | Almanac", "Eugene Oregon last frost spring frost dates");
      return html("U.S. Climate Normals | NCEI", "Eugene Oregon freeze frost dates climate normals spring");
    }) as any;
    const q = "When is the last spring frost in Eugene, Oregon? plan my planting";
    const run = await runToolCalls([{ tool: "fetch", url: "https://www.almanac.com/gardening/frostdates/OR/Eugene" }], fetchImpl, q);
    expect(run.sources[0].url).toMatch(/noaa\.gov/);
    expect(run.sources[0].id).toBe("S1");
    expect(run.sources.some(s => /almanac/.test(s.url))).toBe(true);
    expect(seen.some(u => u.includes("ncei.noaa.gov"))).toBe(true);
    expect(formatToolResultsForPrompt(run)).toMatch(/cite \[S1\] \(OSU, USDA or NOAA\) first/);
  });
  it("follow-ups target OSU, NOAA NCEI and USDA", () => {
    const txt = JSON.stringify(FROST_FALLBACK_CALLS);
    expect(txt).toMatch(/OSU Extension frost/); expect(txt).toMatch(/ncei\.noaa\.gov/); expect(txt).toMatch(/usda\.gov/);
  });
});

describe("(2) one Week-1 anchor per calendar, persisted with it", () => {
  const PLAN = "| Week | Task | Notes |\n|---|---|---|\n| Week 1 | Bed prep | |\n| Week 3 | Sow peas | |";
  const first = buildInlineCalendarArtifact({ artifacts: [], deliverableMarkdown: PLAN, contextText: "calendar for this spring", todayIso: TODAY })!;
  it("first calendar stores its anchor (spring → 2027-03-20)", () => {
    expect(JSON.parse(first.content).anchor).toBe("2027-03-20");
  });
  const history = [{ content: "x", artifacts: [first] }, { content: "T is April 25", artifacts: [] }] as any;
  it("later turns, Week-1 field and Calendar plan all read the persisted value", () => {
    expect(findPersistedCalendarAnchor(history)).toBe("2027-03-20");
    expect(findConversationAnchor(history, TODAY, ["T is April 25"])).toBe("2027-03-20");
    const later = buildInlineCalendarArtifact({ artifacts: [], deliverableMarkdown: PLAN, contextText: "T is April 25", todayIso: TODAY, persistedAnchor: findPersistedCalendarAnchor(history) })!;
    expect(JSON.parse(later.content).anchor).toBe("2027-03-20");
    expect(readFileSync("server/ai.ts", "utf8")).toMatch(/findPersistedCalendarAnchor\(history as any\)/);
  });
});

describe("(3) /ws and /vite-hmr upgrades on a dev-mode server (real routes + Vite middlewareMode, query strings)", () => {
  const PORT = 20000 + Math.floor(Math.random() * 20000);
  let proc: ChildProcess;
  beforeAll(async () => {
    proc = spawn("npx", ["tsx", "server/index.ts"], { env: { ...process.env, NODE_ENV: "development", REPL_ID: "test", SESSION_SECRET: "test-only-not-a-secret", PORT: String(PORT), DATABASE_URL: "" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("dev server did not start: " + out.slice(-800))), 150000);
      let out = "";
      const onData = (d: unknown) => { out += String(d); if (out.includes(`serving on port ${PORT}`)) { clearTimeout(to); resolve(); } };
      proc.stdout!.on("data", onData);
      proc.stderr!.on("data", (d) => { out += String(d); });
      proc.on("exit", (code) => { clearTimeout(to); reject(new Error(`dev server exited ${code}: ${out.slice(-800)}`)); });
    });
  }, 160000);
  afterAll(() => { try { process.kill(-proc.pid!, "SIGTERM"); } catch { proc?.kill("SIGTERM"); } });
  const probe = (path: string, opts: { proto?: string; cookie?: string } = {}) => new Promise<string>((r) => {
    const w = new WebSocket(`ws://localhost:${PORT}${path}`, opts.proto, { headers: { origin: `http://localhost:${PORT}`, ...(opts.cookie ? { cookie: opts.cookie } : {}) } });
    const to = setTimeout(() => { r("TIMEOUT"); w.terminate(); }, 5000);
    w.on("open", () => { if (opts.proto) { clearTimeout(to); r("OPEN"); w.close(); } });
    w.on("message", (m) => { clearTimeout(to); r("MSG " + String(m).slice(0, 40)); w.close(); });
    w.on("unexpected-response", (_q, res) => { clearTimeout(to); r("HTTP " + res.statusCode); });
    w.on("close", (c) => { clearTimeout(to); r("CLOSE " + c); });
    w.on("error", (e) => { clearTimeout(to); r("ERR " + e.message); });
  });
  it("upgrade listener attached once; /ws with query string is routed (auth then decides)", async () => {
    expect((readFileSync("server/routes.ts", "utf8").match(/httpServer\.on\("upgrade"/g) ?? []).length).toBe(1);
    expect(await probe("/ws?x=1")).toBe("CLOSE 4401");
    const res = await fetch(`http://localhost:${PORT}/api/dev-login`, { method: "POST" });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toMatch(/^connect\.sid=/);
    expect(await probe("/ws?x=1", { cookie })).toMatch(/^MSG .*connection/);
    expect(await probe("/ws?token=abc", { cookie })).toMatch(/^MSG .*connection/);
  }, 20000);
  it("Vite HMR gets its upgrade at /vite-hmr?token= (bad token 400, real token opens)", async () => {
    expect(await probe("/vite-hmr?token=x", { proto: "vite-hmr" })).toBe("HTTP 400");
    const client = await (await fetch(`http://localhost:${PORT}/@vite/client`)).text();
    const tok = /const wsToken = "([^"]+)"/.exec(client)?.[1];
    expect(tok).toBeTruthy();
    expect(client).toMatch(/\/vite-hmr/);
    expect(await probe(`/vite-hmr?token=${tok}`, { proto: "vite-hmr" })).toBe("OPEN");
  }, 20000);
  it("client polls messages while /ws is down so replies appear without reload", () => {
    expect(readFileSync("client/src/pages/home-page.tsx", "utf8")).toMatch(/refetchInterval: socketStatus === "connected" \? false : 4000/);
  });
});

describe("SOFT", () => {
  it("warm-season transplants dated after the quoted last-frost average", () => {
    expect(afterLastFrost("Transplant warm-season crops", "2027-03-10", "2027-03-25")).toBe("2027-04-01");
    expect(afterLastFrost("Transplant tomatoes", "2027-05-20", "2027-03-25")).toBe("2027-05-20");
    expect(afterLastFrost("Sow peas", "2027-03-01", "2027-03-25")).toBe("2027-03-01");
  });
  it("notes do not repeat the title", () => {
    expect(notesWithoutTitle("Week 3 — Sow peas — 1 in deep", "Sow peas — Week 3")).toBe("Week 3 — 1 in deep");
    const ev = finalizeCalendarEvents([{ summary: "Bed prep", startDate: "2027-03-20", description: "Bed prep — compost 2 in" }], undefined);
    expect(ev[0].description).toBe("compost 2 in");
  });
  it("Preview header uses conversation or calendar title, never 'New Conversation'", () => {
    expect(calendarDisplayName("Eugene spring veg", [], [])).toBe("Eugene spring veg");
    expect(calendarDisplayName("New Conversation", [{ content: "", artifacts: [{ type: "calendar", title: "Spring vegetable calendar", content: "{}" }] }] as any)).toBe("Spring vegetable calendar");
    expect(calendarDisplayName("New Conversation", [], [{ filename: "spring-veg-calendar-2027.md", uploadedBy: "Expert:A" }] as any)).toBe("Spring veg calendar 2027");
  });
  it("chart captions show source titles, not raw URLs", () => {
    expect(readFileSync("client/src/components/artifacts/VegaChart.tsx", "utf8")).toMatch(/\{readableSourceTitle\(undefined, source\)\}<\/a>/);
    expect(readableSourceTitle(undefined, "https://www.ncei.noaa.gov/access/us-climate-normals/")).toBe("ncei.noaa.gov — Us Climate Normals");
  });
  it("inline calendar applies the frost rule", () => {
    const md = "| Week | Task | Notes |\n|---|---|---|\n| Week 1 | Transplant warm-season crops | last frost Mar 25 |";
    const a = buildInlineCalendarArtifact({ artifacts: [], deliverableMarkdown: md, contextText: "spring calendar", todayIso: TODAY })!;
    expect(parseInlineCalendar(a.content)!.events[0].startDate).toBe("2027-04-01");
  });
});

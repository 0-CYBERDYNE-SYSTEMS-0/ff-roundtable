/**
 * Core tools every roundtable expert can use (web search, page fetch,
 * deliverables, sourced charts). Works with any chat model via a small text
 * protocol, so free OpenRouter models and local Ollama models both qualify.
 *
 * Cost controls: one planning call per turn, at most MAX_TOOL_CALLS_PER_TURN
 * tool executions (fewer on Free), no paid search API required. Search uses
 * DuckDuckGo's HTML endpoint ($0); if it fails the expert answers without
 * sources and says so.
 */
import fs from "fs";
import path from "path";
import { randomBytes, randomUUID } from "crypto";
import { lookup } from "dns/promises";
import net from "net";
import { compile, type TopLevelSpec } from "vega-lite";
import { premiumChartsEnabled } from "./chart-picker";
import { parseChartJsonWithRepair, fallbackSpecFromRows, hoistNestedData } from "./chart-repair";
import { parseVegaChart, themedVegaSpec, chartHasPlottableSeries, stripDualAxis, asksForDualAxis, filterRelevantSources, tidySourceList, applyFacetScales, rankSource, ensureFacetWhenAsked, normalizeMixedUnitChart, readableSourceTitle, isFrostClimateQuestion, isAuthoritativeClimateHost } from "@shared/chart-artifact";
import { extractCanonicalFrost, type CanonicalFrost } from "@shared/frost-canonical";

export const MAX_TOOL_CALLS_PER_TURN = 3;
export const TOOL_TIMEOUT_MS = 10_000;
const MAX_PAGE_CHARS = 3_500;
const MAX_RESULTS = 4;

export type ToolCall = { tool: "search"; query: string } | { tool: "fetch"; url: string };
export type ToolSource = { id: string; title: string; url: string; snippet: string };
export type ToolRun = { calls: ToolCall[]; sources: ToolSource[]; notes: string[] };

export function toolCallLimitForTier(tier: string | null | undefined): number {
  return tier === "free" || !tier ? 2 : MAX_TOOL_CALLS_PER_TURN;
}

/** Prompt for the cheap pre-answer planning call. */
export function buildToolPlanningPrompt(role: string, question: string, limit: number): string {
  return `You are the ${role} on a farm advisory roundtable. Before answering, decide whether you need current, citable information from the web for YOUR specialty only.
Reply with at most ${limit} lines, each exactly one of:
SEARCH: <short web search query within your specialty>
FETCH: <https URL you already know is authoritative, e.g. a university extension page>
or reply with the single word NONE if the farmer's facts and your expertise are enough.
When the farmer asks for numbers, a chart, a table, a budget, prices, yields, rates or a comparison, SEARCH for real current data (e.g. USDA NASS, university extension, market reports) so the roundtable can chart real figures.
Prefer SEARCH when you need a source but are unsure the exact URL is reachable; search results are fetched before they can be cited. Use FETCH only for a stable URL you know is relevant.
For decisions involving marketing or hedging, loan or insurance obligations, veterinary or health risks, safety, or regulation, do not reply NONE merely because you know the general advice: SEARCH for at least one relevant authoritative public-agency or university source. For soil-fertility, liming, fertilizer/nutrient-application, conservation-practice, or crop-production recommendations—especially numeric rates, thresholds, or yield claims—also SEARCH for at least one relevant authoritative public-agency or university source. Never search for or contradict a price or condition supplied by the farmer; use it as given. Use farmer-provided soil tests, acres, yields, prices, and field conditions exactly as supplied; never invent missing measurements or a source. If no source can be fetched, say that you could not verify the source-dependent claim and do not invent a citation.
For field-crop calendars, schedules or timing (grass seed, wheat, hazelnuts, hay, row crops), SEARCH the farmer's state extension crop-production or field-crop guides (e.g. "OSU Extension <crop> production guide Willamette Valley"), not home-garden or backyard calendars.
No other text.

Farmer's question / latest discussion:
${question.slice(0, 1500)}`;
}

export function parseToolPlan(text: string, limit: number): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*\d.)\s]+/, "");
    const search = /^SEARCH:\s*(.{3,200})$/i.exec(line);
    const fetchUrl = /^FETCH:\s*(https?:\/\/\S{4,500})$/i.exec(line);
    if (search) calls.push({ tool: "search", query: search[1].trim() });
    else if (fetchUrl) calls.push({ tool: "fetch", url: fetchUrl[1].trim() });
    if (calls.length >= limit) break;
  }
  return calls;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseDuckDuckGoResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < MAX_RESULTS) {
    let url = m[1].replace(/&amp;/g, "&");
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith("//")) url = "https:" + url;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js|[?&]ad_/.test(url)) continue;
    out.push({ url, title: stripHtml(m[2]).slice(0, 160), snippet: stripHtml(m[3]).slice(0, 300) });
  }
  return out;
}

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv6(ip)) return ip === "::1" || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || ip.startsWith("::ffff:127.") || ip === "::";
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Blocks non-http(s), localhost and private-network targets (SSRF guard). */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http(s) URLs can be fetched.");
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(url.hostname)) throw new Error("Private hosts cannot be fetched.");
  const addrs = net.isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
  if (addrs.some(a => isPrivateAddress(a.address))) throw new Error("Private network addresses cannot be fetched.");
  return url;
}

type FetchLike = typeof fetch;
const MAX_PDF_BYTES = 8_000_000;

/** Text of a PDF (extension bulletins are often PDFs). Empty string if none. */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(data);
  const { text } = await extractText(pdf, { mergePages: true });
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export async function webSearch(query: string, fetchImpl: FetchLike = fetch): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const res = await fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": "Mozilla/5.0 (FarmFriend Roundtable research tool)" },
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  return parseDuckDuckGoResults(await res.text());
}

export async function fetchPage(rawUrl: string, fetchImpl: FetchLike = fetch): Promise<{ title: string; url: string; text: string }> {
  const url = await assertPublicUrl(rawUrl);
  const res = await fetchImpl(url.toString(), {
    headers: { "User-Agent": "Mozilla/5.0 (FarmFriend Roundtable research tool)" },
    redirect: "follow",
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`fetch HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (/application\/pdf/.test(type) || /\.pdf($|\?)/i.test(url.pathname)) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_PDF_BYTES) throw new Error(`PDF too large to read (${Math.round(buf.byteLength / 1e6)} MB)`);
    const text = await extractPdfText(buf);
    if (!text) throw new Error("PDF has no extractable text (scanned image?)");
    return { title: url.pathname.split("/").pop() || url.hostname, url: url.toString(), text: text.slice(0, MAX_PAGE_CHARS) };
  }
  if (!/text\/html|text\/plain|application\/xhtml/.test(type)) throw new Error(`unsupported content type ${type.split(";")[0] || "unknown"}`);
  const html = (await res.text()).slice(0, 400_000);
  const title = stripHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? url.hostname).slice(0, 160);
  return { title, url: url.toString(), text: stripHtml(html).slice(0, MAX_PAGE_CHARS) };
}

export const FROST_FALLBACK_CALLS: ToolCall[] = [
  { tool: "search", query: "OSU Extension frost dates Oregon last frost" },
  { tool: "search", query: "NOAA NCEI climate normals freeze dates" },
  { tool: "fetch", url: "https://www.ncei.noaa.gov/access/us-climate-normals/" },
  { tool: "fetch", url: "https://planthardiness.ars.usda.gov/" },
];

/** Executes planned calls; never throws (failures become notes). */
export async function runToolCalls(calls: ToolCall[], fetchImpl: FetchLike = fetch, questionText?: string): Promise<ToolRun> {
  const sources: ToolSource[] = [];
  const notes: string[] = [];
  // Every prompt type (charts, calendars, tables, prose): skip content farms and
  // out-of-region pages (Iowa corn for a Eugene question) before they are fetched.
  const relevant = (url: string) => filterRelevantSources([url], questionText).length > 0;
  for (const call of calls.slice(0, MAX_TOOL_CALLS_PER_TURN)) {
    try {
      if (call.tool === "search") {
        // Best-fitting source first (OSU field-crop guides before home-garden calendars for farm questions).
        const results = (await webSearch(call.query, fetchImpl)).map((r, i) => ({ r, i })).sort((a, b) => rankSource(a.r.url, questionText) - rankSource(b.r.url, questionText) || a.i - b.i).map(({ r }) => r);
        if (!results.length) notes.push(`Search "${call.query}" returned no results.`);
        let verified = results.some(r => sources.some(s => s.url === r.url));
        for (const r of results) {
          if (sources.some(s => s.url === r.url)) { verified = true; break; }
          if (!relevant(r.url)) { notes.push(`Search result ${r.url} skipped: not relevant to the farmer's crop/region.`); continue; }
          try {
            const page = await fetchPage(r.url, fetchImpl);
            sources.push({ id: `S${sources.length + 1}`, title: readableSourceTitle(page.title, page.url, r.title), url: page.url, snippet: page.text });
            verified = true;
            break;
          } catch (error) {
            notes.push(`Search result ${r.url} could not be fetched: ${(error as Error).message}`);
          }
        }
        if (results.length && !verified) notes.push(`Search "${call.query}" returned no fetchable source; do not cite its snippets.`);
      } else {
        if (!relevant(call.url)) { notes.push(`Fetch ${call.url} skipped: not relevant to the farmer's crop/region.`); continue; }
        const page = await fetchPage(call.url, fetchImpl);
        sources.push({ id: `S${sources.length + 1}`, title: readableSourceTitle(page.title, page.url), url: page.url, snippet: page.text });
      }
    } catch (error) {
      notes.push(`${call.tool === "search" ? `Search "${call.query}"` : `Fetch ${call.url}`} failed: ${(error as Error).message}`);
    }
  }
  // Frost / climate answers must lead with OSU, USDA or NOAA: when research found none
  // (e.g. only Almanac.com), run targeted follow-ups before the expert answers.
  if (isFrostClimateQuestion(questionText) && !sources.some(s => isAuthoritativeClimateHost(s.url))) {
    for (const call of FROST_FALLBACK_CALLS) {
      if (sources.some(s => isAuthoritativeClimateHost(s.url))) break;
      try {
        if (call.tool === "search") {
          const results = (await webSearch(call.query, fetchImpl)).filter(r => isAuthoritativeClimateHost(r.url));
          for (const r of results) {
            if (sources.some(s => s.url === r.url)) break;
            try { const page = await fetchPage(r.url, fetchImpl); sources.push({ id: "", title: readableSourceTitle(page.title, page.url, r.title), url: page.url, snippet: page.text }); break; } catch { /* next */ }
          }
        } else {
          const page = await fetchPage(call.url, fetchImpl);
          sources.push({ id: "", title: readableSourceTitle(page.title, page.url), url: page.url, snippet: page.text });
        }
      } catch (error) {
        notes.push(`Frost/climate follow-up ${call.tool === "search" ? call.query : call.url} failed: ${(error as Error).message}`);
      }
    }
    if (!sources.some(s => isAuthoritativeClimateHost(s.url))) notes.push("No OSU, USDA or NOAA frost/climate source could be fetched; say the frost dates are unverified.");
  }
  // Authoritative first across calls (OSU/USDA/NOAA before app frost sites); ids follow the new order.
  const ranked = sources.map((s, i) => ({ s, i })).sort((a, b) => rankSource(a.s.url, questionText) - rankSource(b.s.url, questionText) || a.i - b.i).map(({ s }, i) => ({ ...s, id: `S${i + 1}` }));
  return { calls, sources: ranked, notes };
}

export function formatToolResultsForPrompt(run: ToolRun): string {
  // (sources are pre-ranked: S1 is the most authoritative; frost/climate answers cite it first)
  if (!run.calls.length) return "";
  const lines = [
    "🔎 RESEARCH RESULTS (fetched this turn; cite each source inline as [S1](URL)):",
    "MANDATORY CITATION CONTRACT: If a fetched result directly supports a relevant fact, include at least one concise sentence using only that fact and cite it inline in that same sentence as [S1](URL); do not only add a source list. For a cited sentence, every numeric value must appear in the fetched text—never compute or combine figures in a cited claim. Preserve the source's scope and caveats; put any calculation in a separate sentence and label it as your calculation. If nothing supports a claim, omit or qualify it.",
  ];
  if (run.sources.length && isAuthoritativeClimateHost(run.sources[0].url)) lines.splice(2, 0, "Sources are ordered most authoritative first: for frost dates, freeze risk or climate normals, cite [S1] (OSU, USDA or NOAA) first, before any other source.");
  for (const s of run.sources) lines.push(`[${s.id}] ${s.title} — ${s.url}\n${s.snippet}`);
  if (!run.sources.length) lines.push("No sources could be retrieved. Say that you could not verify current information; do not invent citations.");
  for (const n of run.notes) lines.push(`(note: ${n})`);
  return lines.join("\n");
}

export function buildToolUsePrompt(): string {
  return `🧰 YOUR TOOLS (stay inside your specialty):
- Sources: if RESEARCH RESULTS include relevant fetched pages, cite supported claims inline as [S1](URL) in the same sentence. Never cite a URL that is not listed there or given by the farmer, or cite a page only because it covers the same topic.
- Citation accuracy: a citation supports only what the fetched page states. Keep each cited sentence within the source's scope; do not append inference, estimates, or unrelated conclusions. Every cited number must appear in the fetched text; never compute a total, average, or range inside a cited claim. Split separate claims into separate sentences and cite each from its own supporting source. If evidence does not support a detail, qualify, omit, or say you could not verify it.
- Deliverables: to create or revise a document for the farmer (plan, checklist, budget, SOP), add ONE block at the end:
\`\`\`deliverable
title: <short descriptive title>
---
<markdown content>
\`\`\`
Reusing the same title revises that document as a new version. You may only revise documents you wrote (or that the farmer explicitly asked you to change); otherwise your block is saved as a proposal for the owner.
- Charts: put the chart JSON in a fenced block tagged \`chart\` (\`\`\`chart ... \`\`\`), never \`json\`, with every brace closed. Use numbers the farmer gave, the weather data provided, or RESEARCH RESULTS / SHARED RESEARCH. Every chart JSON must include "title" (specific, e.g. "June rainfall vs. 30-yr normal, Ames IA") and "sources" (URLs from the research results, or "farmer" / "weather"). If no real data exists for a requested chart, still make it from stated typical assumptions: start the title with "Illustrative:", list the assumptions in "description", and set "sources": ["assumptions"]. Never copy example numbers.
- HTML visuals: for a richer visual (infographic, annotated diagram, interactive calculator, SVG chart) you may return one self-contained \`\`\`html block (inline CSS/SVG/JS, no external scripts or network calls).
- Code and tables: use fenced code blocks with a language tag, and GitHub markdown tables for comparisons.`;
}

// ---------- Deliverables ----------

export type ParsedDeliverable = { title: string; content: string };

export function extractDeliverable(text: string): { deliverable: ParsedDeliverable | null; cleanContent: string } {
  // Models often nest fenced tables inside the block or omit the closing
  // fence; take everything up to a closing fence on its own line, else to the end.
  // Accept the fenced form and the unfenced variants models produce
  // ("**deliverable**" / "deliverable:" on its own line, then "title:").
  let start = text.search(/```\s*deliverable[^\n]*\n/i);
  if (start < 0) {
    const loose = /(^|\n)[ \t]*(?:[*_#>]+[ \t]*)?deliverable[ \t]*(?:[*_]+)?[ \t]*:?[ \t]*\n(?=[ \t]*(?:[*_]+)?title[ \t]*(?:[*_]+)?:)/i.exec(text);
    if (!loose) return { deliverable: null, cleanContent: text };
    start = loose.index + loose[1].length;
  }
  const bodyStart = text.indexOf("\n", start) + 1;
  let depth = 0; let end = -1;
  const lines = text.slice(bodyStart).split("\n"); let offset = bodyStart;
  for (const line of lines) {
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      if (fence[1]) depth++;
      else if (depth > 0) depth--;
      else { end = offset; break; }
    }
    offset += line.length + 1;
  }
  const m = [null, text.slice(bodyStart, end < 0 ? text.length : end)] as const;
  const re = { full: text.slice(start, end < 0 ? text.length : Math.min(text.length, text.indexOf("\n", end) < 0 ? text.length : text.indexOf("\n", end) + 1)) };
  const body = m[1];
  const titleMatch = /^\s*(?:[*_]+)?title(?:[*_]+)?:\s*(?:[*_]+)?(.+?)(?:[*_]+)?\s*$/im.exec(body);
  const sep = body.indexOf("\n---");
  const content = (sep >= 0 ? body.slice(sep + 4) : body.replace(/^\s*title:.*$/im, "")).trim();
  const title = (titleMatch?.[1] ?? "").trim().slice(0, 100);
  const cleanContent = text.replace(re.full, "").trim();
  if (!title || content.length < 20) return { deliverable: null, cleanContent };
  return { deliverable: { title, content: content.slice(0, 20_000) }, cleanContent };
}

export function deliverableIdForTitle(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "document";
  return `expert-${slug}`;
}

export type RevisionContext = {
  /** The farmer's latest message: an explicit request to this expert is a handoff. */
  farmerMessage?: { content: string; mentions?: string[] | null } | null;
};

function ownerName(file: { uploadedBy?: string | null }): string {
  return (file.uploadedBy ?? "").replace(/^Expert:\s*/, "") || "another expert";
}

/**
 * Ownership: the expert who wrote the current version owns it. Another expert
 * may revise only on an explicit farmer handoff (the farmer's latest message
 * @mentions that expert and asks for a revision/takeover).
 */
export function canRevise(
  current: { uploadedBy?: string | null },
  expert: { name: string; role: string },
  context: RevisionContext = {},
): boolean {
  if (!current.uploadedBy || current.uploadedBy === `Expert: ${expert.name}`) return true;
  const farmer = context.farmerMessage;
  if (!farmer) return false;
  const addressed = (farmer.mentions ?? []).some(m => m.toLowerCase() === expert.role.toLowerCase());
  return addressed && /\b(revis|edit|updat|rewrit|take over|takeover|amend|add|change|fix)/i.test(farmer.content);
}

type DeliverableStore = {
  getCurrentDeliverableFile(conversationId: number, deliverableId: string): Promise<{ id: number; version?: number | null; uploadedBy?: string | null } | undefined>;
  saveDeliverableVersion(file: any, request: any): Promise<{ file: { id: number; filename: string; version?: number | null }; created: boolean }>;
};

export async function saveExpertDeliverable(
  store: DeliverableStore,
  conversationId: number,
  expert: { name: string; role: string },
  deliverable: ParsedDeliverable,
  uploadsDir = path.join(process.cwd(), "uploads"),
  context: RevisionContext = {},
): Promise<{ id: number; filename: string; version: number; revised: boolean; title: string; proposalFor: { title: string; owner: string } | null }> {
  let deliverableId = deliverableIdForTitle(deliverable.title);
  let current = await store.getCurrentDeliverableFile(conversationId, deliverableId);
  let proposalFor: { title: string; owner: string } | null = null;
  if (current && !canRevise(current, expert, context)) {
    // Not the author and no explicit handoff: save the change as a proposal
    // the owner or the farmer can adopt, never overwrite someone else's doc.
    proposalFor = { title: deliverable.title, owner: ownerName(current) };
    deliverable = { ...deliverable, title: `${deliverable.title} (proposed by ${expert.role})` };
    deliverableId = deliverableIdForTitle(deliverable.title);
    current = await store.getCurrentDeliverableFile(conversationId, deliverableId);
  }
  const filename = `${deliverableId.replace(/^expert-/, "")}.md`;
  const unique = `${randomBytes(8).toString("hex")}-${filename}`;
  await fs.promises.mkdir(uploadsDir, { recursive: true });
  const filePath = path.join(uploadsDir, unique);
  const header = `# ${deliverable.title}\n\n_Prepared by ${expert.name} (${expert.role}). Advice, not a field measurement._\n\n`;
  await fs.promises.writeFile(filePath, header + deliverable.content.replace(/^#\s+.*\n+/, ""), "utf8");
  try {
    const saved = await store.saveDeliverableVersion(
      { conversationId, filename, fileUrl: `/uploads/${unique}`, fileType: "text/markdown", uploadedBy: `Expert: ${expert.name}` },
      {
        deliverableId,
        generationRequestId: randomUUID(),
        mode: current ? "revise" : "create",
        ...(current ? { expectedCurrentFileId: current.id } : {}),
        constraints: { format: "markdown" },
      },
    );
    return { id: saved.file.id, filename: saved.file.filename, version: saved.file.version ?? 1, revised: Boolean(current), title: deliverable.title, proposalFor };
  } catch (error) {
    await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

// ---------- Charts ----------

const GENERIC_TITLES = /^(chart( artifact)?|visual aid|data|trend|untitled|illustrative( chart)?|seasonal agricultural trends)$/i;

/** Models often drop trailing closers from long JSON; add the missing ones before giving up. */
function parseChartJson(text: string): unknown {
  try { return JSON.parse(text); } catch (error) {
    const closers: string[] = [];
    let inString = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") closers.push("}");
      else if (c === "[") closers.push("]");
      else if (c === "}" || c === "]") { if (closers.pop() !== c) throw error; }
    }
    if (inString || !closers.length) throw error;
    return JSON.parse(text + closers.reverse().join(""));
  }
}

/** Charts built from stated assumptions are allowed when visibly labeled "Illustrative". */
export function isIllustrativeChart(chart: any): boolean {
  return [chart?.title, chart?.description, chart?.subtitle, chart?.caption]
    .some(v => typeof v === "string" && /\billustrative\b/i.test(v));
}

export type ChartArtifactRejectionReason =
  | "invalid-json"
  | "empty-series"
  | "invalid-vega-envelope"
  | "invalid-vega-spec"
  | "missing-title"
  | "generic-title"
  | "missing-source"
  | "unverified-source"
  | "missing-data";

export type ChartEvidence = { farmerText?: string; weatherText?: string; researchUrls?: string[] };

/** Research URLs this turn's text actually cites (by [S1]/[R1] id or URL); all fetched URLs if none are cited explicitly. */
export function chartResearchUrls(text: string, sources: Array<Pick<ToolSource, "id" | "url">>): string[] {
  const cited = sources.filter(s => s.url && (text.includes(s.url) || (s.id && text.toUpperCase().includes(`[${s.id.toUpperCase()}]`))));
  const picked = (cited.length ? cited : sources).map(s => s.url).filter(Boolean);
  return Array.from(new Set(picked)).slice(0, 5);
}

type ChartValidationResult =
  | { ok: true; json: string; title: string }
  | { ok: false; reason: ChartArtifactRejectionReason };

function numericDataValues(data: unknown[]): number[] {
  return data.flatMap(row => row && typeof row === "object" && !Array.isArray(row)
    ? Object.values(row).filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    : []);
}

function evidenceContainsChartNumbers(data: unknown[], text: string | undefined): boolean {
  if (!text) return false;
  const values = numericDataValues(data);
  if (!values.length) return false;
  const evidenceNumbers = new Set((text.match(/[-+]?\d+(?:\.\d+)?/g) ?? []).map(Number));
  return values.every(value => evidenceNumbers.has(value));
}

function inferChartSource(data: unknown[], evidence: ChartEvidence): "farmer" | "weather" | undefined {
  if (evidenceContainsChartNumbers(data, evidence.farmerText)) return "farmer";
  if (evidenceContainsChartNumbers(data, evidence.weatherText)) return "weather";
  return undefined;
}

/**
 * Keeps a chart only when it is labeled and every source is real: a URL
 * retrieved this turn, "farmer", or "weather".
 */
export function validateChartArtifactDetailed(
  chartJson: string,
  allowedUrls: string[],
  evidence: ChartEvidence = {},
): ChartValidationResult {
  let chart: any;
  const premium = premiumChartsEnabled();
  try { chart = parseChartJson(chartJson); } catch {
    if (!premium) return { ok: false, reason: "invalid-json" };
    try { chart = parseChartJsonWithRepair(chartJson).value; } catch { return { ok: false, reason: "invalid-json" }; }
  }
  if (!chart || typeof chart !== "object" || Array.isArray(chart)) return { ok: false, reason: "invalid-json" };

  const title = typeof chart.title === "string" ? chart.title.trim() : "";
  if (!title) return { ok: false, reason: "missing-title" };
  if (GENERIC_TITLES.test(title)) return { ok: false, reason: "generic-title" };
  if (premium && chart.spec && typeof chart.spec === "object") hoistNestedData(chart);
  if (!Array.isArray(chart.data) || chart.data.length === 0) return { ok: false, reason: "missing-data" };

  let sources: unknown[] = Array.isArray(chart.sources) && chart.sources.length
    ? chart.sources
    : typeof chart.source === "string" ? [chart.source] : [];
  if (!sources.length) {
    const inferredSource = inferChartSource(chart.data, evidence);
    if (inferredSource) {
      sources = [inferredSource];
    }
  }
  const illustrative = isIllustrativeChart(chart);
  if (!sources.length && illustrative) sources = ["assumptions"];
  if (!sources.length) return { ok: false, reason: "missing-source" };
  if (!Array.isArray(chart.sources) || chart.sources.length === 0) chart.sources = sources;

  if (premium && chart && typeof chart === "object" && !chart.type && chart.spec) chart.type = "vega-lite";
  if (chart?.type === "vega-lite") {
    let parsed = parseVegaChart(chart);
    const compiles = (c: NonNullable<typeof parsed>) => { try { compile(themedVegaSpec(c) as unknown as TopLevelSpec); return true; } catch { return false; } };
    if ((!parsed || !compiles(parsed)) && premium) {
      // Fallback: keep the model's rows, title and sources; rebuild a plain themed chart.
      const spec = Array.isArray(chart.data) ? fallbackSpecFromRows(chart.data) : null;
      const rebuilt = spec ? parseVegaChart({ ...chart, spec }) : null;
      if (rebuilt && compiles(rebuilt)) parsed = rebuilt;
      else return { ok: false, reason: parsed ? "invalid-vega-spec" : "invalid-vega-envelope" };
    }
    if (!parsed) return { ok: false, reason: "invalid-vega-envelope" };
    if (!compiles(parsed)) return { ok: false, reason: "invalid-vega-spec" };
    if (premium) {
      if (!asksForDualAxis(evidence.farmerText)) parsed = { ...parsed, spec: stripDualAxis(parsed.spec as Record<string, unknown>) as typeof parsed.spec };
      parsed = { ...parsed, spec: ensureFacetWhenAsked(parsed.spec as Record<string, unknown>, evidence.farmerText ?? "") as typeof parsed.spec };
      { const mixed = normalizeMixedUnitChart(parsed as any); parsed = { ...(parsed as any), data: mixed.data, spec: mixed.spec as typeof parsed.spec }; }
      { const f = applyFacetScales(parsed as any); parsed = { ...(parsed as any), spec: f.spec, ...(f.description ? { description: f.description } : {}) }; }
      if (!chartHasPlottableSeries(parsed as any)) {
        // Axes with no series: rebuild from the rows, or drop the chart.
        const spec = fallbackSpecFromRows((parsed as any).data as Record<string, unknown>[]);
        const rebuilt = spec ? parseVegaChart({ ...chart, data: (parsed as any).data, spec }) : null;
        if (!rebuilt || !compiles(rebuilt) || !chartHasPlottableSeries(rebuilt)) return { ok: false, reason: "empty-series" };
        parsed = rebuilt;
      }
    }
    chart = parsed;
  }
  const allowed = new Set(allowedUrls);
  const isAssumption = (s: unknown) => typeof s === "string" && /^(assumptions?|illustrative)$/i.test(s.trim());
  const accepted = (s: unknown) => typeof s === "string" && (allowed.has(s.trim()) || /^(farmer|weather)$/i.test(s.trim()) || (illustrative && isAssumption(s)));
  let ok = sources.every(accepted);
  if (!ok && premium) {
    // Models often name a fetched page by title ("OSU EM 8538") or tweak its URL.
    // Map URL variants onto the fetched URL and drop unverifiable labels; keep the
    // chart only if a verified/assumption source remains.
    const norm = (u: string) => u.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[#?].*$/, "").replace(/\/+$/, "");
    const byNorm = new Map(Array.from(allowed).map(u => [norm(u), u]));
    const mapped = sources.map(s => typeof s === "string" && !accepted(s) && /^https?:\/\//i.test(s.trim()) ? byNorm.get(norm(s)) ?? s : s).filter(accepted);
    if (mapped.length) { sources = Array.from(new Set(mapped)); ok = true; }
  }
  if (!ok) return { ok: false, reason: "unverified-source" };
  // The footer lists the real research behind the turn, not just "assumptions".
  let research = (evidence.researchUrls ?? []).filter(u => allowed.has(u));
  if (premium) {
    research = filterRelevantSources(research, evidence.farmerText);
    const relevant = filterRelevantSources(sources.filter((x): x is string => typeof x === "string"), evidence.farmerText);
    if (!relevant.length) {
      if (!illustrative) return { ok: false, reason: "unverified-source" };
      sources = ["assumptions"];
    } else sources = relevant;
  }
  if (research.length && sources.every(isAssumption)) sources = [...research, ...sources];
  if (premium) sources = tidySourceList(sources as string[]);
  if (chart && typeof chart === "object") chart.sources = sources;
  return { ok: true, json: JSON.stringify(chart, null, 2), title };
}

export function validateChartArtifact(
  chartJson: string,
  allowedUrls: string[],
  evidence: ChartEvidence = {},
): { json: string; title: string } | null {
  const result = validateChartArtifactDetailed(chartJson, allowedUrls, evidence);
  return result.ok ? { json: result.json, title: result.title } : null;
}

/** Applies validateChartArtifact to extracted artifacts and reports why charts were rejected. */
export function filterChartArtifacts<T extends { type: string; content: string; title?: string }>(
  artifacts: T[],
  allowedUrls: string[],
  evidence: ChartEvidence = {},
): { kept: T[]; dropped: number; droppedReasons: ChartArtifactRejectionReason[] } {
  let dropped = 0;
  const kept: T[] = [];
  const droppedReasons: ChartArtifactRejectionReason[] = [];
  for (const a of artifacts) {
    if (a.type !== "chart") { kept.push(a); continue; }
    const valid = validateChartArtifactDetailed(a.content, allowedUrls, evidence);
    if (!valid.ok) { dropped++; droppedReasons.push(valid.reason); continue; }
    kept.push({ ...a, content: valid.json, title: valid.title });
  }
  return { kept, dropped, droppedReasons };
}

// ---------- Shared roundtable research ----------
// Sources fetched by any expert (or the Research Analyst's retrieval) are shared
// with every other expert in the same roundtable and count as chart sources.
const SHARED_RESEARCH_TTL_MS = 6 * 60 * 60 * 1000;
const SHARED_RESEARCH_MAX = 8;
const sharedResearchStore = new Map<number, { at: number; sources: ToolSource[] }>();
const canonicalFrostStore = new Map<number, CanonicalFrost[]>();

export function rememberCanonicalFrost(conversationId: number | undefined, text: string, sources: ToolSource[]): CanonicalFrost | null {
  if (!conversationId) return null;
  const value = extractCanonicalFrost(text, sources);
  if (!value) return null;
  const existing = canonicalFrostStore.get(conversationId) ?? [];
  if (!existing.some(item => item.location.toLowerCase() === value.location.toLowerCase())) canonicalFrostStore.set(conversationId, [...existing, value]);
  return existing.find(item => item.location.toLowerCase() === value.location.toLowerCase()) ?? value;
}

export function getCanonicalFrost(conversationId: number | undefined): CanonicalFrost[] {
  return conversationId ? canonicalFrostStore.get(conversationId) ?? [] : [];
}

export function rememberSharedResearch(conversationId: number | undefined, sources: Array<Pick<ToolSource, "title" | "url" | "snippet">>, now = Date.now()): void {
  if (!conversationId || !sources.length) return;
  const entry = sharedResearchStore.get(conversationId);
  const existing = entry && now - entry.at < SHARED_RESEARCH_TTL_MS ? entry.sources : [];
  const merged = [...existing];
  for (const s of sources) if (s.url && !merged.some(m => m.url === s.url)) merged.push({ id: "", title: s.title, url: s.url, snippet: s.snippet });
  const kept = merged.slice(-SHARED_RESEARCH_MAX).map((s, i) => ({ ...s, id: `R${i + 1}` }));
  sharedResearchStore.set(conversationId, { at: now, sources: kept });
}

export function getSharedResearch(conversationId: number | undefined, now = Date.now()): ToolSource[] {
  if (!conversationId) return [];
  const entry = sharedResearchStore.get(conversationId);
  if (!entry || now - entry.at >= SHARED_RESEARCH_TTL_MS) return [];
  return entry.sources;
}

export function formatSharedResearchForPrompt(sources: ToolSource[], excludeUrls: string[] = [], frost: CanonicalFrost[] = []): string {
  const shown = sources.filter(s => !excludeUrls.includes(s.url));
  const frostLines = frost.map(f => `CANONICAL FROST (use this value, do not contradict it): last spring frost for ${f.location} ≈ ${f.lastFrost}${f.threshold ? ` [${f.threshold}]` : ""} per ${f.sourceTitle} (${f.sourceUrl}).`);
  if (!shown.length && !frostLines.length) return "";
  return [...frostLines, ...(shown.length ? ["📚 SHARED RESEARCH from other experts in this roundtable (fetched pages; cite as [R1](URL); usable as chart sources by URL):", ...shown.map(s => `[${s.id}] ${s.title} — ${s.url}\n${s.snippet.slice(0, 1200)}`)] : [])].join("\n");
}

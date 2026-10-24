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
import { parseVegaChart, themedVegaSpec } from "@shared/chart-artifact";

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
Prefer SEARCH when you need a source but are unsure the exact URL is reachable; search results are fetched before they can be cited. Use FETCH only for a stable URL you know is relevant.
For decisions involving marketing or hedging, loan or insurance obligations, veterinary or health risks, safety, or regulation, do not reply NONE merely because you know the general advice: SEARCH for at least one relevant authoritative public-agency or university source. For soil-fertility, liming, fertilizer/nutrient-application, conservation-practice, or crop-production recommendations—especially numeric rates, thresholds, or yield claims—also SEARCH for at least one relevant authoritative public-agency or university source. Never search for or contradict a price or condition supplied by the farmer; use it as given. Use farmer-provided soil tests, acres, yields, prices, and field conditions exactly as supplied; never invent missing measurements or a source. If no source can be fetched, say that you could not verify the source-dependent claim and do not invent a citation.
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

/** Executes planned calls; never throws (failures become notes). */
export async function runToolCalls(calls: ToolCall[], fetchImpl: FetchLike = fetch): Promise<ToolRun> {
  const sources: ToolSource[] = [];
  const notes: string[] = [];
  for (const call of calls.slice(0, MAX_TOOL_CALLS_PER_TURN)) {
    try {
      if (call.tool === "search") {
        const results = await webSearch(call.query, fetchImpl);
        if (!results.length) notes.push(`Search "${call.query}" returned no results.`);
        let verified = results.some(r => sources.some(s => s.url === r.url));
        for (const r of results) {
          if (sources.some(s => s.url === r.url)) { verified = true; break; }
          try {
            const page = await fetchPage(r.url, fetchImpl);
            sources.push({ id: `S${sources.length + 1}`, title: page.title || r.title, url: page.url, snippet: page.text });
            verified = true;
            break;
          } catch (error) {
            notes.push(`Search result ${r.url} could not be fetched: ${(error as Error).message}`);
          }
        }
        if (results.length && !verified) notes.push(`Search "${call.query}" returned no fetchable source; do not cite its snippets.`);
      } else {
        const page = await fetchPage(call.url, fetchImpl);
        sources.push({ id: `S${sources.length + 1}`, title: page.title, url: page.url, snippet: page.text });
      }
    } catch (error) {
      notes.push(`${call.tool === "search" ? `Search "${call.query}"` : `Fetch ${call.url}`} failed: ${(error as Error).message}`);
    }
  }
  return { calls, sources, notes };
}

export function formatToolResultsForPrompt(run: ToolRun): string {
  if (!run.calls.length) return "";
  const lines = [
    "🔎 RESEARCH RESULTS (fetched this turn; cite each source inline as [S1](URL)):",
    "MANDATORY CITATION CONTRACT: If a fetched result directly supports a relevant fact, include at least one concise sentence using only that fact and cite it inline in that same sentence as [S1](URL); do not only add a source list. For a cited sentence, every numeric value must appear in the fetched text—never compute or combine figures in a cited claim. Preserve the source's scope and caveats; put any calculation in a separate sentence and label it as your calculation. If nothing supports a claim, omit or qualify it.",
  ];
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
- Charts: put the chart JSON in a fenced block tagged \`chart\` (\`\`\`chart ... \`\`\`), never \`json\`, with every brace closed. Only from numbers the farmer gave, the weather data provided, or the research results. Every chart JSON must include "title" (specific, e.g. "June rainfall vs. 30-yr normal, Ames IA") and "sources" (list of URLs from RESEARCH RESULTS, or "farmer" / "weather"). If you have no real data, do not make a chart. Never use example or illustrative numbers.`;
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
  | "invalid-vega-envelope"
  | "invalid-vega-spec"
  | "missing-title"
  | "generic-title"
  | "missing-source"
  | "unverified-source"
  | "missing-data";

export type ChartEvidence = { farmerText?: string; weatherText?: string };

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
  try { chart = parseChartJson(chartJson); } catch { return { ok: false, reason: "invalid-json" }; }
  if (!chart || typeof chart !== "object" || Array.isArray(chart)) return { ok: false, reason: "invalid-json" };

  const title = typeof chart.title === "string" ? chart.title.trim() : "";
  if (!title) return { ok: false, reason: "missing-title" };
  if (GENERIC_TITLES.test(title)) return { ok: false, reason: "generic-title" };
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

  if (chart?.type === "vega-lite") {
    const parsed = parseVegaChart(chart);
    if (!parsed) return { ok: false, reason: "invalid-vega-envelope" };
    try { compile(themedVegaSpec(parsed) as unknown as TopLevelSpec); } catch { return { ok: false, reason: "invalid-vega-spec" }; }
    chart = parsed;
  }
  const allowed = new Set(allowedUrls);
  const ok = sources.every(s => typeof s === "string" && (allowed.has(s.trim()) || /^(farmer|weather)$/i.test(s.trim()) || (illustrative && /^(assumptions?|illustrative)$/i.test(s.trim()))));
  if (!ok) return { ok: false, reason: "unverified-source" };
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

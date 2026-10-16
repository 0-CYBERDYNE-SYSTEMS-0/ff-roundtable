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
        for (const r of results) {
          if (sources.some(s => s.url === r.url)) continue;
          sources.push({ id: `S${sources.length + 1}`, ...r });
        }
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
  const lines = ["🔎 RESEARCH RESULTS (fetched this turn; cite as [S1] etc. with the URL):"];
  for (const s of run.sources) lines.push(`[${s.id}] ${s.title} — ${s.url}\n${s.snippet}`);
  if (!run.sources.length) lines.push("No sources could be retrieved. Say that you could not verify current information; do not invent citations.");
  for (const n of run.notes) lines.push(`(note: ${n})`);
  return lines.join("\n");
}

export function buildToolUsePrompt(): string {
  return `🧰 YOUR TOOLS (stay inside your specialty):
- Sources: if RESEARCH RESULTS are provided, cite them inline as [S1](URL). Never cite a URL that is not listed there or given by the farmer.
- Deliverables: to create or revise a document for the farmer (plan, checklist, budget, SOP), add ONE block at the end:
\`\`\`deliverable
title: <short descriptive title>
---
<markdown content>
\`\`\`
Reusing the same title revises that document as a new version.
- Charts: only from numbers the farmer gave, the weather data provided, or the research results. Every chart JSON must include "title" (specific, e.g. "June rainfall vs. 30-yr normal, Ames IA") and "sources" (list of URLs from RESEARCH RESULTS, or "farmer" / "weather"). If you have no real data, do not make a chart. Never use example or illustrative numbers.`;
}

// ---------- Deliverables ----------

export type ParsedDeliverable = { title: string; content: string };

export function extractDeliverable(text: string): { deliverable: ParsedDeliverable | null; cleanContent: string } {
  const re = /```deliverable\s*\n([\s\S]*?)```/i;
  const m = re.exec(text);
  if (!m) return { deliverable: null, cleanContent: text };
  const body = m[1];
  const titleMatch = /^\s*title:\s*(.+)$/im.exec(body);
  const sep = body.indexOf("\n---");
  const content = (sep >= 0 ? body.slice(sep + 4) : body.replace(/^\s*title:.*$/im, "")).trim();
  const title = (titleMatch?.[1] ?? "").trim().slice(0, 100);
  const cleanContent = text.replace(re, "").replace(/```deliverable[\s\S]*$/i, "").trim();
  if (!title || content.length < 20) return { deliverable: null, cleanContent };
  return { deliverable: { title, content: content.slice(0, 20_000) }, cleanContent };
}

export function deliverableIdForTitle(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "document";
  return `expert-${slug}`;
}

type DeliverableStore = {
  getCurrentDeliverableFile(conversationId: number, deliverableId: string): Promise<{ id: number; version?: number | null } | undefined>;
  saveDeliverableVersion(file: any, request: any): Promise<{ file: { id: number; filename: string; version?: number | null }; created: boolean }>;
};

export async function saveExpertDeliverable(
  store: DeliverableStore,
  conversationId: number,
  expert: { name: string; role: string },
  deliverable: ParsedDeliverable,
  uploadsDir = path.join(process.cwd(), "uploads"),
): Promise<{ id: number; filename: string; version: number; revised: boolean }> {
  const deliverableId = deliverableIdForTitle(deliverable.title);
  const current = await store.getCurrentDeliverableFile(conversationId, deliverableId);
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
    return { id: saved.file.id, filename: saved.file.filename, version: saved.file.version ?? 1, revised: Boolean(current) };
  } catch (error) {
    await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

// ---------- Charts ----------

const GENERIC_TITLES = /^(chart( artifact)?|visual aid|data|trend|untitled|seasonal agricultural trends)$/i;

/**
 * Keeps a chart only when it is labeled and every source is real: a URL
 * retrieved this turn, "farmer", or "weather". Returns null to drop it.
 */
export function validateChartArtifact(chartJson: string, allowedUrls: string[]): { json: string; title: string } | null {
  let chart: any;
  try { chart = JSON.parse(chartJson); } catch { return null; }
  const title = typeof chart?.title === "string" ? chart.title.trim() : "";
  if (!title || GENERIC_TITLES.test(title)) return null;
  const sources: unknown[] = Array.isArray(chart?.sources) ? chart.sources : typeof chart?.source === "string" ? [chart.source] : [];
  if (!sources.length) return null;
  const allowed = new Set(allowedUrls);
  const ok = sources.every(s => typeof s === "string" && (allowed.has(s.trim()) || /^(farmer|weather)$/i.test(s.trim())));
  if (!ok) return null;
  if (!Array.isArray(chart?.data) || chart.data.length === 0) return null;
  return { json: JSON.stringify(chart, null, 2), title };
}

/** Applies validateChartArtifact to extracted artifacts; drops unsourced charts. */
export function filterChartArtifacts<T extends { type: string; content: string; title?: string }>(
  artifacts: T[],
  allowedUrls: string[],
): { kept: T[]; dropped: number } {
  let dropped = 0;
  const kept: T[] = [];
  for (const a of artifacts) {
    if (a.type !== "chart") { kept.push(a); continue; }
    const valid = validateChartArtifact(a.content, allowedUrls);
    if (!valid) { dropped++; continue; }
    kept.push({ ...a, content: valid.json, title: valid.title });
  }
  return { kept, dropped };
}

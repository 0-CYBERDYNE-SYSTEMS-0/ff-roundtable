import { storage } from "./storage";
// Import shared DB types
import type { InsertMessage, Expert, InsertFile, Message, File, Artifact, FarmProfile, MessageStance, OpenQuestion } from "@shared/schema";
import { extractArtifacts } from "./artifact-extractor";
import { extractMentions } from "@shared/mentions";
import OpenAI from "openai";
import path from "path";
import fs from "fs";
import axios from "axios";
import { randomBytes } from "crypto";
import { getProvider } from "./ai-providers";
import { findCatalogExpert } from "@shared/expert-catalog";
import { DELIVERABLE_PLACEHOLDER, pendingDeliverableFor, pendingDeliverableByMessage } from "./pending-deliverables";
export { commitPendingDeliverable, discardPendingDeliverable } from "./pending-deliverables";
import { enforceCitationIntegrity, removeUnsupportedCitedSentences, stripMetaLines, undecorate, mergeDuplicateFarmerQuestions, removeRepeatedExpertSentences } from "./response-hygiene";
import {
  buildToolUsePrompt, buildToolPlanningPrompt, parseToolPlan, runToolCalls, formatToolResultsForPrompt,
  toolCallLimitForTier, extractDeliverable, saveExpertDeliverable, filterChartArtifacts, type ToolRun,
} from "./expert-tools";

/** Expert tools are on by default; EXPERT_TOOLS=off disables them. Unit tests never hit the network. */
export function expertToolsEnabled(): boolean {
  return process.env.EXPERT_TOOLS !== "off" && !process.env.VITEST;
}

/** Paid OpenRouter web plugin only on explicit opt-in; free DuckDuckGo tools are the default. */
function paidWebPluginEnabled(): boolean {
  return process.env.OPENROUTER_WEB_PLUGIN === "true";
}

async function runExpertToolPhase(expert: Expert, question: string, userId?: number): Promise<ToolRun | null> {
  if (!expertToolsEnabled() || expert.role === "Moderator" || expert.role === "File Creator") return null;
  let tier: string | undefined;
  try { tier = userId ? (await storage.getUser(userId))?.tier ?? undefined : undefined; } catch { tier = undefined; }
  const limit = toolCallLimitForTier(tier);
  let plan = "NONE";
  try {
    const planning = await callOpenRouterAPI([
      { role: "system", content: buildToolPlanningPrompt(expert.role, question, limit) },
      { role: "user", content: "List your tool calls now (or NONE)." },
    ], expert.model, userId);
    plan = planning.message.content ?? "NONE";
  } catch (error) {
    console.warn(`[TOOLS] planning failed for ${expert.role}: ${(error as Error).message}`);
    return null;
  }
  const calls = parseToolPlan(plan, limit);
  if (!calls.length) return null;
  const run = await runToolCalls(calls);
  console.log(`[TOOLS] ${expert.role}: ${calls.length} call(s), ${run.sources.length} source(s)${run.notes.length ? `, notes: ${run.notes.join("; ")}` : ""}`);
  return run;
}

function stripModelSourcesSection(content: string): string {
  const lines = content.split("\n");
  const sourcesIndex = lines.findIndex(line => /^\s*(?:\*\*)?Sources(?:\*\*)?:.*$/i.test(line));
  return sourcesIndex < 0 ? content : lines.slice(0, sourcesIndex).join("\n").trimEnd();
}

/** Saves an expert deliverable block and appends sources actually cited. Returns the farmer-facing text. */
async function finalizeExpertTools(
  expert: Expert,
  content: string,
  toolRun: ToolRun | null,
  deliverable: ReturnType<typeof extractDeliverable>["deliverable"],
  history: Message[] = [],
): Promise<{ content: string; addition: string }> {
  let text = stripModelSourcesSection(content);
  let addition = "";
  const citation = enforceCitationIntegrity(text, toolRun?.sources ?? [], history.map(m => m.content));
  if (citation.removedMarkers || citation.removedUrls) {
    console.log(`[CITATIONS] ${expert.role}: removed ${citation.removedMarkers} invalid marker(s), ${citation.removedUrls} unverified URL(s)`);
  }
  text = citation.content;
  const supportedCitationText = removeUnsupportedCitedSentences(text, toolRun?.sources ?? []);
  if (supportedCitationText.removed) {
    console.log(`[CITATION_SUPPORT] ${expert.role}: removed ${supportedCitationText.removed} unsupported cited claim(s)`);
  }
  text = supportedCitationText.content;
  let lastFarmer = -1;
  history.forEach((m, i) => { if (m.role === "user") lastFarmer = i; });
  const recentExperts = history.slice(lastFarmer + 1)
    .filter(m => m.role === "assistant" && m.expertRole);
  const recent = recentExperts
    .filter(m => m.expertRole !== expert.role)
    .map(m => ({ role: m.expertRole as string, content: m.content }));
  const questions = mergeDuplicateFarmerQuestions(text, recent);
  if (questions.merged) console.log(`[QUESTIONS] ${expert.role}: merged ${questions.merged} duplicate farmer question(s)`);
  const unique = removeRepeatedExpertSentences(questions.content, recentExperts.map(m => m.content));
  if (unique.removed) console.log(`[REDUNDANCY] ${expert.role}: removed ${unique.removed} repeated sentence(s)`);
  text = unique.content;
  if (deliverable) {
    // Saved only after the orchestrator accepts the turn (a discarded
    // near-duplicate turn must not leave a document behind).
    const line = `\n\n📄 ${DELIVERABLE_PLACEHOLDER}`;
    text += line;
    pendingDeliverableFor.set(expert, deliverable);
  }
  if (toolRun?.sources.length) {
    const cited = toolRun.sources.filter(s => text.includes(`[${s.id.toUpperCase()}]`) || text.includes(s.url));
    if (cited.length) {
      const block = `\n\n**Verified sources:**\n${cited.map(s => `- [${s.id}] [${s.title || s.url}](${s.url})`).join("\n")}`;
      text += block; addition += block;
    }
  }
  return { content: text, addition };
}
import { collectImageParts, isImageFile, MAX_IMAGE_PARTS, analyzedImageNote, makeAnalyzedBeforePredicate, type ImagePart } from "./image-context";

const AI_REQUEST_TIMEOUT_MS = 120_000;
const MAX_MODEL_MESSAGE_CHARS = 12_000;
const MAX_PERPLEXITY_DISCUSSION_CHARS = MAX_MODEL_MESSAGE_CHARS * 2;
const MAX_FILE_CONTEXT_FILES = 10;
// G9: cap on the carried-forward PRIOR DECISIONS system block.
const PRIOR_DECISIONS_MAX_CHARS = 1200;
const INCOMPLETE_EXPERT_RESPONSE_MESSAGE = "⚠️ No complete response was received. Try a shorter request or split it into smaller requests, then retry. You can also continue with the work available so far.";

function truncateForModel(content: string, maxChars = MAX_MODEL_MESSAGE_CHARS): string {
  return content.length > maxChars
    ? `${content.slice(0, maxChars)}\n... [Content Truncated] ...`
    : content;
}

function sanitizeGeneratedFilename(filename: string): string {
  const basename = path.basename(filename);
  return basename.replace(/[^a-zA-Z0-9_.-]/g, "_") || "generated-file";
}

export interface DeliverableGenerationRequest {
  deliverableId: string;
  generationRequestId: string;
  mode: "create" | "revise";
  expectedCurrentFileId?: number;
  constraints: {
    format?: string;
    maxCharacters?: number;
    requiredSections?: string[];
    taskCount?: number;
    datedTasks?: boolean;
  };
}

type DeliverableFormat = {
  name: string;
  extensions: readonly string[];
  mimeTypes: readonly string[];
};

const DELIVERABLE_FORMATS: readonly DeliverableFormat[] = [
  { name: "markdown", extensions: [".md", ".markdown"], mimeTypes: ["text/markdown", "text/plain"] },
  { name: "text", extensions: [".txt"], mimeTypes: ["text/plain"] },
  { name: "csv", extensions: [".csv"], mimeTypes: ["text/csv"] },
  { name: "json", extensions: [".json"], mimeTypes: ["application/json"] },
  { name: "html", extensions: [".html", ".htm"], mimeTypes: ["text/html"] },
  { name: "ics", extensions: [".ics"], mimeTypes: ["text/calendar"] },
];

type DeliverableFile = File & { version?: number | null; supersededAt?: Date | null };

class SafeDeliverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeDeliverableError";
  }
}

// The shared storage contract is being added by the integration lead. Keep
// this local until its schema-facing types land.
interface DeliverableStorage {
  saveDeliverableVersion(
    file: InsertFile,
    request: DeliverableGenerationRequest,
  ): Promise<{ file: DeliverableFile; created: boolean }>;
  getCurrentDeliverableFile(
    conversationId: number,
    deliverableId: string,
  ): Promise<DeliverableFile | undefined>;
}

function getDeliverableFormat(format?: string): DeliverableFormat | null {
  if (!format?.trim()) return null;
  const normalized = format.trim().toLowerCase().replace(/\s*\([^)]*\)/g, "").replace(/^\./, "");
  const aliases: Record<string, string> = {
    md: "markdown",
    "text/markdown": "markdown",
    "text/x-markdown": "markdown",
    markdown: "markdown",
    txt: "text",
    text: "text",
    "plain text": "text",
    "text/plain": "text",
    csv: "csv",
    "text/csv": "csv",
    json: "json",
    "application/json": "json",
    html: "html",
    htm: "html",
    "text/html": "html",
    ics: "ics",
    calendar: "ics",
    "text/calendar": "ics",
  };
  const name = aliases[normalized];
  const resolved = DELIVERABLE_FORMATS.find((candidate) => candidate.name === name);
  if (!resolved) {
    throw new SafeDeliverableError(`The requested file format “${format}” is not supported for generated text files.`);
  }
  return resolved;
}

function validateDeliverableRequest(request: DeliverableGenerationRequest): DeliverableFormat | null {
  if (!request.deliverableId.trim() || !request.generationRequestId.trim()) {
    throw new SafeDeliverableError("The deliverable request is missing its server-issued identity.");
  }
  if (request.mode !== "create" && request.mode !== "revise") {
    throw new SafeDeliverableError("The deliverable request mode is invalid.");
  }
  if (request.mode === "revise" && (!Number.isInteger(request.expectedCurrentFileId) || request.expectedCurrentFileId! < 1)) {
    throw new SafeDeliverableError("A revision must identify the current file version it will replace.");
  }
  const { maxCharacters, requiredSections, taskCount } = request.constraints;
  if (maxCharacters !== undefined && (!Number.isInteger(maxCharacters) || maxCharacters < 0)) {
    throw new SafeDeliverableError("The requested character limit is invalid.");
  }
  if (taskCount !== undefined && (!Number.isInteger(taskCount) || taskCount < 0)) {
    throw new SafeDeliverableError("The requested task count is invalid.");
  }
  if (requiredSections?.some((section) => !section.trim())) {
    throw new SafeDeliverableError("A required section name is empty.");
  }
  const requestedFormat = getDeliverableFormat(request.constraints.format);
  if ((taskCount !== undefined || requiredSections?.length) && requestedFormat && requestedFormat.name !== "markdown") {
    throw new SafeDeliverableError("Section and task-count constraints currently require Markdown output.");
  }
  return requestedFormat;
}

function buildDeliverableInstructions(request: DeliverableGenerationRequest): string {
  const lines = [
    "Create the requested deliverable. Return only JSON with filename, filetype, and content fields.",
    "Do not include deliverable IDs, generation IDs, filesystem paths, or download URLs.",
  ];
  const { format, maxCharacters, requiredSections, taskCount } = request.constraints;
  if (format) lines.push(`Requested file format: ${format}.`);
  if (maxCharacters !== undefined) lines.push(`The complete saved content, including Markdown, must be at most ${maxCharacters} Unicode code points.`);
  if (requiredSections?.length) lines.push(`Include these exact section headings: ${requiredSections.join(", ")}.`);
  if (taskCount !== undefined) {
    lines.push(`Include a “Tasks” Markdown section containing exactly ${taskCount} top-level list entries, one task per entry.`);
  }
  if (request.constraints.datedTasks) {
    lines.push("Every task must include an explicit valid ISO date (YYYY-MM-DD) supplied by the farmer or farm plan; do not invent dates.");
  }
  return lines.join("\n");
}

function getAuthorizedDownloadUrl(file: Pick<File, "conversationId" | "id">): string {
  return `/api/protected/conversations/${file.conversationId}/files/${file.id}/download`;
}

function countUnicodeCodePoints(content: string): number {
  let count = 0;
  for (let index = 0; index < content.length; index += 1) {
    const current = content.charCodeAt(index);
    const next = content.charCodeAt(index + 1);
    if (current >= 0xd800 && current <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      index += 1;
    }
    count += 1;
  }
  return count;
}

function markdownSection(content: string, title: string): string | null {
  const lines = content.split(/\r?\n/);
  const target = title.trim().replace(/^#+\s*/, "").toLocaleLowerCase();
  const start = lines.findIndex((line) => {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
    return heading?.trim().toLocaleLowerCase() === target;
  });
  if (start < 0) return null;
  const endOffset = lines.slice(start + 1).findIndex((line) => /^\s{0,3}#{1,6}\s+/.test(line));
  return lines.slice(start + 1, endOffset < 0 ? undefined : start + 1 + endOffset).join("\n");
}

function validateGeneratedContent(
  fileData: unknown,
  requestedFormat: DeliverableFormat | null,
  request: DeliverableGenerationRequest,
): { filename: string; filetype: string; content: string } {
  if (!fileData || typeof fileData !== "object") throw new SafeDeliverableError("The File Creator response was not a JSON object.");
  const candidate = fileData as Record<string, unknown>;
  if (typeof candidate.filename !== "string" || !candidate.filename.trim()
      || typeof candidate.filetype !== "string" || !candidate.filetype.trim()
      || typeof candidate.content !== "string" || !candidate.content.trim()) {
    throw new SafeDeliverableError("The File Creator response must contain a filename, filetype, and non-empty string content.");
  }

  const filename = sanitizeGeneratedFilename(candidate.filename);
  const filetype = candidate.filetype.trim().toLowerCase().split(";")[0];
  const content = candidate.content;
  const extension = path.extname(filename).toLowerCase();
  const actualFormat = requestedFormat ?? DELIVERABLE_FORMATS.find(
    (candidateFormat) => candidateFormat.extensions.includes(extension) && candidateFormat.mimeTypes.includes(filetype),
  ) ?? null;
  if (requestedFormat) {
    if (!requestedFormat.extensions.includes(extension) || !requestedFormat.mimeTypes.includes(filetype)) {
      throw new SafeDeliverableError(`The generated filename and file type do not match the requested ${requestedFormat.name} format.`);
    }
  }

  if (request.constraints.format && requestedFormat?.name === "json") {
    try {
      JSON.parse(content);
    } catch {
      throw new SafeDeliverableError("The generated content is not valid JSON.");
    }
  }
  if ((request.constraints.requiredSections?.length || request.constraints.taskCount !== undefined)
      && actualFormat?.name !== "markdown") {
    throw new SafeDeliverableError("Section and task-count constraints require a Markdown file. No file was saved.");
  }
  const maxCharacters = request.constraints.maxCharacters;
  const characterCount = countUnicodeCodePoints(content);
  if (maxCharacters !== undefined && characterCount > maxCharacters) {
    throw new SafeDeliverableError(`The generated content is ${characterCount} Unicode code points; the limit is ${maxCharacters}. No file was saved.`);
  }

  for (const section of request.constraints.requiredSections ?? []) {
    if (!markdownSection(content, section)) {
      throw new SafeDeliverableError(`The generated content is missing the required “${section}” section. No file was saved.`);
    }
  }
  if (request.constraints.taskCount !== undefined || request.constraints.datedTasks) {
    const tasks = markdownSection(content, "Tasks");
    const taskLines = tasks?.split(/\r?\n/).filter((line) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line)) ?? [];
    if (request.constraints.taskCount !== undefined && taskLines.length !== request.constraints.taskCount) {
      throw new SafeDeliverableError(`The generated content has ${taskLines.length} task entries; ${request.constraints.taskCount} are required. No file was saved.`);
    }
    if (request.constraints.datedTasks && taskLines.some(line => {
      const match = line.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
      if (!match) return true;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const date = new Date(Date.UTC(year, month - 1, day));
      return date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day;
    })) {
      throw new SafeDeliverableError("Every task must include a valid ISO date (YYYY-MM-DD). No file was saved.");
    }
  }

  return { filename, filetype, content };
}

async function verifyRevisionTarget(
  conversationId: number,
  request: DeliverableGenerationRequest,
): Promise<void> {
  if (request.mode !== "revise") return;
  const deliverableStorage = storage as unknown as DeliverableStorage;
  if (typeof deliverableStorage.getCurrentDeliverableFile !== "function") {
    throw new SafeDeliverableError("Version storage is not ready; this revision was not generated.");
  }
  let current: DeliverableFile | undefined;
  try {
    current = await deliverableStorage.getCurrentDeliverableFile(conversationId, request.deliverableId);
  } catch {
    throw new SafeDeliverableError("The current file version could not be checked. Retry the revision; no file was changed.");
  }
  if (!current || current.id !== request.expectedCurrentFileId) {
    throw new SafeDeliverableError("The deliverable changed before this revision began. Reload its current version and try again.");
  }
}

async function prepareFileCreatorRequest(
  expert: Expert,
  messages: AIMessage[],
  request?: DeliverableGenerationRequest,
): Promise<DeliverableGenerationRequest> {
  if (!request) {
    throw new SafeDeliverableError("The File Creator needs a server-issued deliverable request before it can generate a file.");
  }
  validateDeliverableRequest(request);
  const deliverableStorage = storage as unknown as DeliverableStorage;
  if (typeof deliverableStorage.saveDeliverableVersion !== "function") {
    throw new SafeDeliverableError("Version storage is not ready; no File Creator request was sent.");
  }
  await verifyRevisionTarget(expert.conversationId, request);
  const systemMessage = messages.find((message) => message.role === "system" && typeof message.content === "string");
  if (systemMessage && typeof systemMessage.content === "string") {
    systemMessage.content += `\n\n${buildDeliverableInstructions(request)}`;
  }
  return request;
}

async function saveGeneratedDeliverable(
  rawContent: string,
  expert: Expert,
  request: DeliverableGenerationRequest,
): Promise<{ file: DeliverableFile; created: boolean }> {
  const requestedFormat = validateDeliverableRequest(request);
  let fileData: unknown;
  try {
    fileData = JSON.parse(rawContent);
  } catch {
    throw new Error("The File Creator response was not valid JSON. No file was saved.");
  }
  const generated = validateGeneratedContent(fileData, requestedFormat, request);
  const uploadsDir = path.join(process.cwd(), "uploads");
  const uniqueFilename = `${randomBytes(8).toString("hex")}-${generated.filename}`;
  const filePath = path.join(uploadsDir, uniqueFilename);
  const fileUrl = `/uploads/${uniqueFilename}`;

  const newFile: InsertFile = {
    conversationId: expert.conversationId,
    filename: generated.filename,
    fileUrl,
    fileType: generated.filetype,
    uploadedBy: `Expert: ${expert.name}`,
  };
  try {
    const deliverableStorage = storage as unknown as DeliverableStorage;
    if (typeof deliverableStorage.saveDeliverableVersion !== "function") {
      throw new SafeDeliverableError("Version storage is not ready; the generated draft was not saved.");
    }
    await fs.promises.mkdir(uploadsDir, { recursive: true });
    await fs.promises.writeFile(filePath, generated.content, "utf8");
    const saved = await deliverableStorage.saveDeliverableVersion(newFile, request);
    if (!saved.created) await fs.promises.rm(filePath, { force: true });
    return saved;
  } catch (error) {
    await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
    if (error instanceof SafeDeliverableError) throw error;
    throw new SafeDeliverableError("The generated file could not be saved. Retry the request; no new version was stored.");
  }
}

function expertResponseErrorMessage(error: unknown, expertName: string, imageParts: ImagePart[]): string {
  if (isVisionRejection(error, imageParts)) return visionRejectionMessage(expertName);
  if (error instanceof SafeDeliverableError) return error.message;
  return INCOMPLETE_EXPERT_RESPONSE_MESSAGE;
}

function deliverableSuccessMessage(
  saved: { file: DeliverableFile; created: boolean },
  request: DeliverableGenerationRequest,
): string {
  const action = !saved.created ? "Using existing file" : request.mode === "revise" ? "Revised file" : "Created file";
  return `${action}: ${saved.file.filename} (version ${saved.file.version ?? 1})\nDownload: ${getAuthorizedDownloadUrl(saved.file)}`;
}

// Multimodal content parts (OpenAI chat-completions format) — used to deliver
// uploaded images to vision-capable models alongside the text part.
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

// Define the structure for messages sent to AI APIs
export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface AIModelResponse {
  message: {
    role: string;
    content: string;
  };
  citations?: string[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number | string;
  };
  providerGenerationId?: string;
  providerModel?: string;
  providerName?: string;
}

function requireNonEmptyAssistantContent(response: AIModelResponse): void {
  if (typeof response?.message?.content !== "string" || !response.message.content.trim()) {
    throw new Error("Empty assistant response");
  }
}

// AI-facing Moderator identity. A roster Moderator carries its persisted
// expert row ID; the system Moderator is synthetic and has no expert row.
export interface ModeratorContext {
  id: number | null;
  conversationId: number;
  name: string;
  role: "Moderator";
  model: string | null;
  systemPrompt: string;
}

const STANCE_LINE_PREFIX = "STANCE:";
const STANCE_VALUES = ["agree", "disagree", "conditional", "abstain"] as const;

/** Parse and remove a final trailing STANCE line, whether valid or malformed. */
export function parseTrailingStanceLine(content: string): {
  content: string;
  stance: MessageStance | null;
} {
  const lines = content.split("\n");
  let finalLineIndex = lines.length - 1;
  while (finalLineIndex >= 0 && lines[finalLineIndex].replace(/\r$/, "").trim() === "") {
    finalLineIndex -= 1;
  }
  if (finalLineIndex < 0) return { content, stance: null };

  // Models sometimes bold/quote/bullet the line ("**STANCE: …**"); formatting must not hide it.
  const finalLine = undecorate(lines[finalLineIndex].replace(/\r$/, ""));
  if (!/^STANCE\s*:/i.test(finalLine)) return { content, stance: null };

  const lineStart = lines.slice(0, finalLineIndex).reduce(
    (length, line) => length + line.length + 1,
    0,
  );
  const match = finalLine.match(/^STANCE\s*:\s*(agree|disagree|conditional|abstain)\s*\|\s*([1-5])\s*\|\s*(.+?)\s*$/i);
  const stanceValue = match?.[1]?.toLowerCase();
  const position = match?.[3]?.trim();
  const stance = match && position && STANCE_VALUES.includes(stanceValue as typeof STANCE_VALUES[number])
    ? {
        stance: stanceValue as MessageStance["stance"],
        confidence: Number(match[2]) as MessageStance["confidence"],
        position,
      }
    : null;

  return { content: content.slice(0, lineStart), stance };
}

function stripExpertStance(response: AIModelResponse, role: string): MessageStance | null {
  if (role === "Moderator") return null;
  const parsed = parseTrailingStanceLine(response.message.content);
  // Any remaining metadata line (mid-message STANCE, tool-protocol lines) is
  // removed too; a mid-message STANCE still counts if no trailing one existed.
  const meta = stripMetaLines(parsed.content);
  response.message.content = meta.content;
  if (parsed.stance || !meta.stanceLine) return parsed.stance;
  return parseTrailingStanceLine(meta.stanceLine).stance;
}

/**
 * Stream response text while withholding a possible final STANCE line. A
 * marker is released only if later non-whitespace content proves it was not
 * the final line, so structured metadata never flashes in the live response.
 */
export class TrailingStanceStreamFilter {
  private mode: "body" | "prefix" | "marker" | "after-marker" = "prefix";
  private held = "";

  constructor(private readonly emit: (text: string) => void) {}

  push(chunk: string): void {
    let output = "";
    const marker = STANCE_LINE_PREFIX;
    for (const char of chunk) {
      let reprocess = true;
      while (reprocess) {
        reprocess = false;
        if (this.mode === "body") {
          if (char === "\n") {
            output += char;
            this.mode = "prefix";
          } else {
            output += char;
          }
        } else if (this.mode === "prefix") {
          const indentationLength = this.held.match(/^[ \t>*_`#~-]*/)?.[0].length ?? 0;
          const markerProgress = this.held.length - indentationLength;
          if (markerProgress === 0 && /[ \t>*_`#~-]/.test(char)) {
            this.held += char;
          } else if (char.toUpperCase() === marker[markerProgress]) {
            this.held += char;
            if (markerProgress + 1 === marker.length) this.mode = "marker";
          } else if (char === "\n") {
            output += this.held + char;
            this.held = "";
            this.mode = "prefix";
          } else {
            output += this.held + char;
            this.held = "";
            this.mode = "body";
          }
        } else if (this.mode === "marker") {
          this.held += char;
          if (char === "\n") this.mode = "after-marker";
        } else if (/\s/.test(char)) {
          this.held += char;
        } else {
          // The held marker was followed by a later nonblank line, so it is
          // ordinary body text. The current character starts that next line.
          output += this.held;
          this.held = "";
          this.mode = "prefix";
          reprocess = true;
        }
      }
    }
    if (output) this.emit(output);
  }

  finish(): void {
    if (this.mode === "prefix" && this.held) this.emit(this.held);
    // A complete marker and following whitespace are trailing metadata and
    // intentionally discarded; no held text can otherwise remain here.
    this.held = "";
  }
}

// Generate a system prompt for an expert
// Pass availableRoles separately, plus optional farm context, weather, and the
// conversation's council charter (G6 — governs every expert when present).
export function generateSystemPrompt(
  expert:
    Pick<Expert, "role">
    & Partial<Pick<Expert, "customInstructions">>
    & Partial<Pick<ModeratorContext, "systemPrompt">>,
  availableRoles?: string[],
  farmContext?: string,
  weatherContext?: string,
  charter?: string | null
): string {
  let basePrompt = `You are an AI expert in the role of ${expert.role} participating in a roundtable discussion on agricultural topics.
As a ${expert.role}, your expertise is highly valued, and you should focus on providing insights specific to your domain.
Always be respectful, helpful, and conversational while maintaining your expert perspective.

You are part of a team of experts: [${availableRoles?.join(', ') || 'various roles'}].
`;

  // G10: the Moderator context may provide system-level instructions without
  // needing a persisted Expert row. Keep those instructions on the Moderator
  // prompt path only; ordinary experts retain their existing prompt behavior.
  if (expert.role === "Moderator" && expert.systemPrompt?.trim()) {
    basePrompt += `\nMODERATOR SYSTEM INSTRUCTIONS:\n${expert.systemPrompt.trim()}\n`;
  }

  // G14: keep cross-talk guidance on ordinary expert prompts only; the
  // Moderator/chair prompt remains unchanged.
  if (expert.role !== "Moderator") {
    const colleagueRoles = (availableRoles ?? []).filter(
      role => role !== expert.role && role !== "Moderator" && role !== "User" && role !== "Farmer",
    );
    const colleagues = colleagueRoles.length > 0 ? ` Colleagues (not you): [${colleagueRoles.join(", ")}].` : "";
    basePrompt += `\n🎭 STAY IN ROLE: you are the ${expert.role} only. Answer from your specialty; when a point belongs to another specialty, hand it to that colleague with @[Role] instead of answering it yourself.\n`;
    basePrompt += `\n🔁 READ THE TABLE FIRST: before writing, read each colleague's most recent message. Unless you are the first to speak on this farmer message, open with one sentence that names a colleague and builds on or disagrees with a specific point they made (e.g. "Building on the Soil Scientist's buffer-capacity point…" / "I disagree with Pest Management that…"). In that sentence, use the colleague's full role name and carry forward at least two specific domain terms of five or more letters from their latest message; then add a distinct fact, qualification, trade-off, or handoff. Do not repeat their action step, calculation, or farmer question; if you have nothing new to add, say so plainly rather than padding.\n`;
    basePrompt += `\n💬 CROSS-TALK: Build on or challenge colleagues by name ("I agree with X because…" / "I disagree with X on…").${colleagues} Tag @[Role] only when you need that specialty or want that expert to defend a point; never tag yourself or force a tag every turn. Add new information or an objection instead of repeating settled points.\n`;
  }

  // Inject farmer's custom instructions for this expert if present
  if (expert.customInstructions?.trim()) {
    basePrompt += `\n📌 CUSTOM INSTRUCTIONS FROM THE FARMER (follow these closely):\n${expert.customInstructions.trim()}\n`;
  }

  // G6: inject the farmer's council charter. It governs the whole roundtable
  // (goal, depth, stop criteria), so it sits above per-farm context.
  if (charter?.trim()) {
    basePrompt += `\n📜 COUNCIL CHARTER (governs this roundtable — all experts):\n${charter.trim()}\nAll experts follow this charter.\n`;
  }

  // Inject farm profile context if available
  if (farmContext) {
    basePrompt += `\n🌾 FARMER CONTEXT — You are advising a REAL farmer with this operation:\n${farmContext}\n\nCRITICAL: Tailor ALL your advice to this specific farm. Reference their crops, acreage, soil type, location, and water situation directly. Do NOT give generic advice that ignores these details.\n`;
  }

  // Inject weather context if available
  if (weatherContext) {
    basePrompt += `\n🌤️ CURRENT WEATHER AT THE FARM:\n${weatherContext}\n\nUse this weather data to inform your recommendations about irrigation, planting, pest pressure, field operations, and harvest timing.\n`;
  }

  const interactionPrompt = `During discussion, actively engage with other experts. Reference their points and ask clarifying questions.
You can direct the discussion: if you write @[Role Name], that expert will be asked to speak next. Tag only when their expertise is genuinely needed; otherwise speak to the whole table.
Keep responses concise: lead with the answer, then include only useful evidence, calculations, limits, and next steps.
Clearly distinguish facts supplied by the farmer, fictional or example prices and inputs, calculations, and assumptions. Keep units with values, and do not present fictional inputs as farm facts. Avoid unqualified farm-specific prescriptions when evidence or required farm inputs are missing; state the uncertainty and what is needed.
If you need a fact only the farmer can know, ask one concise, plain-language question on its own line beginning exactly "Farmer question:". Do not use an @[User] mention for that question. If useful, put a separate next line beginning "Assuming <reasonable assumption>" and continue with that qualified assumption without waiting for the farmer to answer.

DATA & VISUALS: never invent numbers. Tables and charts may only use numbers the farmer gave, the weather data provided, or sources retrieved this turn, and must say where each number came from. If you have no real data, explain in words instead of drawing a chart.

${expert.role === "Moderator" ? "" : buildToolUsePrompt()}
`;

  // Add role-specific instructions
  let roleInstructions = "";
  
  switch (expert.role) {
    case "Soil Scientist":
      roleInstructions = `Focus on soil health, composition, testing methods, and fertilization recommendations.
Provide insights on soil types, pH levels, nutrient content, organic matter, and sustainable soil management practices.
When appropriate, explain how soil conditions impact crop growth and farm productivity.`;
      break;
    case "Crop Specialist":
      roleInstructions = `Focus on crop varieties, rotation strategies, planting techniques, and yield optimization.
Provide insights on seed selection, crop health, disease identification, and sustainable farming methods.
When appropriate, explain how different crop choices and techniques impact overall farm productivity.`;
      break;
    case "Irrigation Engineer":
      roleInstructions = `Focus on water management systems, irrigation scheduling, water conservation, and drainage solutions.
Provide insights on irrigation technologies, water quality, efficiency improvements, and sustainable water use.
When appropriate, explain how water management impacts crop health and farm sustainability.`;
      break;
    case "Pest Management":
      roleInstructions = `Focus on insect, disease, and weed control using integrated pest management techniques.
Provide insights on pest identification, prevention strategies, biological controls, and judicious use of pesticides.
When appropriate, explain how pest management impacts crop health, yield, and environmental sustainability.`;
      break;
    case "Meteorologist":
      roleInstructions = `Focus on weather patterns, climate impacts on agriculture, and seasonal forecasting.
Provide insights on temperature trends, precipitation patterns, extreme weather events, and climate adaptation strategies.
When appropriate, explain how weather conditions impact farming decisions and risk management.`;
      break;
    case "File Creator":
      roleInstructions = `You specialize in creating useful files based on the discussion (e.g., reports, plans, data summaries, code snippets). 
      When asked to create a file, respond ONLY with a JSON object containing the file details. 
      The JSON object MUST have the following structure:
      {
        "filename": "your_suggested_filename.ext",
        "filetype": "mime/type or descriptive type like 'text/plain', 'text/csv', 'application/json', etc.",
        "content": "The full content of the file goes here as a string. Ensure proper escaping if the content itself is JSON or contains special characters."
      }
      Do NOT include any other text, explanation, or formatting outside of this JSON object in your response.
      Do not choose deliverable IDs, generation IDs, filesystem paths, or download URLs.
      `;
      break;
    case "Research Analyst":
      roleInstructions = `Research the question using available search results and prioritize primary sources, such as government agencies, university extension, official datasets, and peer-reviewed research. Keep the response concise. Where possible, place the exact retrieved URL next to the factual claim it supports; use only exact URLs returned by retrieval. Never invent or guess source titles, publication dates, quotations, or URLs, and do not imply a URL or its support was independently verified. Distinguish farmer-provided facts, fictional or example prices and inputs, calculations, and assumptions. Do not give an unqualified farm-specific prescription when required evidence or farm inputs are missing. Say when supporting evidence is unavailable and qualify the claim.`;
      break;
    case "Imagery Specialist":
      roleInstructions = `Focus on analyzing satellite, drone, or field imagery to provide visual insights and interpretations. If images are provided, describe what you see and its relevance.
Uploaded images are delivered to you directly as native vision input — describe and analyze what you actually see in them.`;
      break;
    case "Moderator":
      roleInstructions = `Facilitate the discussion, summarize key points, ensure all experts contribute, and manage conversation flow.
      When asked who should speak next, analyze the last few messages and the overall goal. Respond ONLY with the role name of the expert who should speak next (e.g., 'Crop Specialist'). Do not add any other text.
      G5: you may also end the roundtable — if the discussion has run its course (the farmer's question is answered, decisions are made, and further turns would only repeat the table), respond ONLY with 'Conclude' and the council will close with a final synthesis from you. If unsure, suggest 'RoundRobin'.`;
      break;
    default:
      roleInstructions = findCatalogExpert(expert.role)?.rolePrompt
        ?? `You are a custom expert. Stay within the "${expert.role}" specialty described by the farmer's custom instructions; say when a question is outside it.`;
  }

  const stanceInstruction = expert.role === "Moderator" || expert.role === "File Creator"
    ? ""
    : `\n\nAt the very end of every response, add exactly one machine-readable stance line in this format:\nSTANCE: <agree|disagree|conditional|abstain> | <confidence 1-5> | <one-line position>\nUse one of the four stance values exactly (case-insensitive), an integer confidence from 1 to 5, and a concise one-line position. Put no text after this line. This line will be removed from the farmer-facing response.`;

  return basePrompt + interactionPrompt + roleInstructions + stanceInstruction;
}

// Function to call AI API (routes through provider abstraction)
export async function callOpenRouterAPI(messages: AIMessage[], model: string, userId?: number, webSearch = false): Promise<AIModelResponse> {
  const provider = getProvider(model);
  return provider.chat(messages, model, userId, webSearch);
}

// Function to call AI API with streaming (SSE) — routes through provider abstraction
export async function callOpenRouterAPIStream(
  messages: AIMessage[], 
  model: string,
  onToken: (token: string) => void,
  userId?: number,
  webSearch = false
): Promise<AIModelResponse> {
  const provider = getProvider(model);
  return provider.chatStream(messages, model, onToken, userId, webSearch);
}

const PERPLEXITY_RESEARCH_SYSTEM_PROMPT = `You are a Research Analyst specializing in agriculture. Provide concise, accurate information with relevant citations. Keep responses short. Where possible, place exact retrieved URLs next to the factual claims they support; use only URLs returned by retrieval and do not imply independent verification. Distinguish farmer facts, fictional or example prices and inputs, calculations, and assumptions. Qualify recommendations when evidence or farm-specific inputs are missing.`;

function getMessageText(content: AIMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function buildPerplexityMessages(query: string, contextMessages: AIMessage[] = []): AIMessage[] {
  const researchPrompt = contextMessages[0]?.role === "system"
    ? getMessageText(contextMessages[0].content)
    : "";
  let lastUserIndex = -1;
  for (let index = contextMessages.length - 1; index >= 0; index -= 1) {
    if (contextMessages[index].role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  const precedingMessages = contextMessages.slice(
    researchPrompt ? 1 : 0,
    lastUserIndex >= 0 ? lastUserIndex : undefined,
  );
  const precedingContext = precedingMessages
    .map((message) => {
      const content = getMessageText(message.content);
      return content ? `${message.role.toUpperCase()}:\n${content}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  const currentQuestion = `Current question:\n${truncateForModel(query)}`;
  const contextHeader = "Recent discussion context:\n";
  const availableContextChars = Math.max(
    0,
    MAX_PERPLEXITY_DISCUSSION_CHARS - currentQuestion.length - contextHeader.length - 2,
  );
  const wasTruncated = precedingContext.length > availableContextChars;
  const omissionMarker = wasTruncated ? "[Earlier discussion omitted]\n" : "";
  const boundedContextChars = Math.max(0, availableContextChars - omissionMarker.length);
  const boundedContext = boundedContextChars > 0
    ? precedingContext.slice(-boundedContextChars)
    : "";
  const userContext = [
    precedingContext
      ? `${contextHeader}${omissionMarker}${boundedContext}`
      : "",
    currentQuestion,
  ].filter(Boolean).join("\n\n");

  return [{
    role: "system",
    content: [PERPLEXITY_RESEARCH_SYSTEM_PROMPT, researchPrompt].filter(Boolean).join("\n\n"),
  }, { role: "user", content: userContext }];
}

function appendRetrievedCitationUrls(content: string, citations?: string[]): { content: string; addition: string } {
  const urls = (citations ?? []).filter((url, index, allUrls) =>
    typeof url === "string" && url.length > 0 && allUrls.indexOf(url) === index && !content.includes(url),
  );
  if (urls.length === 0) return { content, addition: "" };

  const separator = content.length === 0
    ? ""
    : content.endsWith("\n\n")
      ? ""
      : content.endsWith("\n")
        ? "\n"
        : "\n\n";
  const addition = `${separator}URLs returned by retrieval:\n${urls.map((url) => `- ${url}`).join("\n")}`;
  return { content: `${content}${addition}`, addition };
}

// Function to call Perplexity API for web search
export async function callPerplexityAPI(query: string, contextMessages: AIMessage[] = []): Promise<AIModelResponse> {
  try {
    const perplexityKey = process.env.PERPLEXITY_API_KEY;
    if (!perplexityKey) {
      throw new Error("Perplexity API key not provided");
    }
    
    console.log("Calling Perplexity API for research query");
    
    const response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${perplexityKey}`
      },
      body: JSON.stringify({
        model: "sonar",
        messages: buildPerplexityMessages(query, contextMessages),
        temperature: 0.2,
        max_tokens: 1024,
        stream: false
      }),
      signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Perplexity API Error (${response.status}): ${errorText}`);
    }
    
    const data = await response.json();
    
    if (!data || !data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
      console.error("Invalid response from Perplexity API:", JSON.stringify(data));
      throw new Error("Invalid response format from Perplexity API");
    }
    
    if (!data.choices[0] || !data.choices[0].message) {
      console.error("Missing message in Perplexity API response:", JSON.stringify(data.choices[0]));
      throw new Error("Missing message in Perplexity API response");
    }
    
    const citations = Array.isArray(data.citations)
      ? data.citations.filter((url: unknown): url is string => typeof url === "string" && url.length > 0)
      : undefined;
    return {
      message: data.choices[0].message,
      ...(citations ? { citations } : {}),
    };
  } catch (error: unknown) {
    console.error("Error calling Perplexity API");
    if (error instanceof Error) {
      throw error;
    } else {
      throw new Error(`Unknown error: ${String(error)}`);
    }
  }
}

// Helper function to safely map DB roles to AI API roles
const mapDbRoleToApiRole = (dbRole: string): AIMessage['role'] => {
  if (dbRole === 'user') return 'user';
  if (dbRole === 'assistant') return 'assistant';
  if (dbRole === 'system') return 'system';
  return 'assistant'; 
};

// Helper function to read and truncate file content
async function readFileContent(file: File, maxLength = 2000): Promise<string | null> {
    const isTextBased = file.fileType.startsWith('text/') || 
                       ['csv', 'json', 'javascript', 'typescript', 'python', 'markdown'].some(ext => file.fileType.includes(ext));

    if (!isTextBased) {
        return `[Content of non-text file (${file.fileType}) is not available in this context]`;
    }

    try {
        const relativePath = file.fileUrl.startsWith('/') ? file.fileUrl.substring(1) : file.fileUrl;
        const filePath = path.join(process.cwd(), relativePath); 

        if (!fs.existsSync(filePath)) {
             console.error(`readFileContent: File not found at path: ${filePath} (derived from ${file.fileUrl})`);
             return `[File ${file.filename} not found on server]`;
        }

        const content = await fs.promises.readFile(filePath, 'utf8');
        if (content.length > maxLength) {
            return content.substring(0, maxLength) + '\n... [Content Truncated] ...';
        }
        return content;
    } catch (error) {
        console.error(`readFileContent: Error reading file ${file.filename}:`, error);
        return `[Error reading content of file ${file.filename}]`;
    }
}

/**
 * Build the "Attached Files Context" system message plus native vision parts
 * for the user message. Text files are inlined as before; image/* files are
 * listed as delivered-visually and their base64 image_url parts are returned
 * for appending to the user message content (SPEC §B2-B3).
 *
 * F2 analyze-image-once: user-uploaded images that have already been analyzed
 * (an assistant message exists after the upload) are described by a one-line
 * text note instead of re-embedding their base64 payload on every turn.
 */
async function buildAttachedFilesContext(
    files: File[],
    history: Message[] = []
): Promise<{ context: string | null; imageParts: ImagePart[] }> {
    if (files.length === 0) {
        return { context: null, imageParts: [] };
    }

    const analyzedBefore = makeAnalyzedBeforePredicate(history);
    const { parts: imageParts, skipped: skippedImages, alreadyAnalyzed } =
        await collectImageParts(files, MAX_IMAGE_PARTS, analyzedBefore);

    // Which image filenames actually produced a vision part? Mirror the
    // most-recent-first selection used by collectImageParts so the text
    // listing never claims delivery for an image that was skipped,
    // already analyzed, or beyond the 2-part limit.
    const deliveredImageNames = new Set<string>();
    let deliveredCount = 0;
    for (const file of files.filter(isImageFile).sort((a, b) => {
        const ta = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
        const tb = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
        return tb - ta;
    })) {
        if (alreadyAnalyzed.includes(file.filename)) continue;
        if (deliveredCount >= imageParts.length) break;
        if (skippedImages.includes(file.filename)) continue;
        deliveredImageNames.add(file.filename);
        deliveredCount++;
    }

    let fileContextString = "\n\n--- Attached Files Context ---\n";
    for (const file of files.slice(0, MAX_FILE_CONTEXT_FILES)) {
        fileContextString += `\nFile Name: ${file.filename} (${file.fileType})\n`;
        fileContextString += `Download URL: ${getAuthorizedDownloadUrl(file)}\nUse this exact authorized URL when linking this file; do not construct a URL from its display filename.\n`;
        if (isImageFile(file)) {
            if (deliveredImageNames.has(file.filename)) {
                fileContextString += `[Image attached: ${file.filename} — delivered visually]\n`;
            } else if (alreadyAnalyzed.includes(file.filename)) {
                fileContextString += `${analyzedImageNote(file.filename)}\n`;
            } else if (skippedImages.includes(file.filename)) {
                fileContextString += `[Image attached: ${file.filename} — not delivered (missing or over the 5 MB vision limit)]\n`;
            } else {
                fileContextString += `[Image attached: ${file.filename} — not delivered (vision input is limited to the 2 most recent images)]\n`;
            }
        } else {
            const contentSnippet = await readFileContent(file);
            if (contentSnippet) {
                fileContextString += `Content Snippet:\n\`\`\`\n${contentSnippet}\n\`\`\`\n`;
            }
        }
    }
    fileContextString += "\n--- End Attached Files Context ---\n";

    return { context: fileContextString, imageParts };
}

/**
 * Vision-rejecting providers phrase the failure around the modality ("Image
 * input is not supported by this model"). Requiring a rejection-shaped phrase
 * near the keyword keeps lookalikes honest — e.g. a 429 body that merely echoes
 * a model slug like "llama-3.2-11b-vision-instruct:free" is a rate limit, not a
 * rejection.
 */
const VISION_REJECTION_RE = new RegExp(
  "(?:image|vision|modalit|multimodal)[\\s\\S]{0,80}(?:not\\s+support|unsupport\\w*|reject\\w*|invalid|disabled|not\\s+allowed|can(?:not|'t)|unable)" +
  "|" +
  "(?:not\\s+support|unsupport\\w*|reject\\w*|invalid|disabled|not\\s+allowed|can(?:not|'t)|unable)[\\s\\S]{0,80}(?:image|vision|modalit|multimodal)" +
  "|" +
  // OpenRouter's real rejection shape: 404 "No endpoints found that support image input"
  "(?:support|accept|allow|handle)\\s+(?:[\\w-]+\\s+){0,2}(?:image|vision|multimodal|modalit)",
  "i",
);

/**
 * True when a provider error looks like the model rejected the vision input
 * itself AND this turn actually sent image parts.
 *
 * Status-bearing 4xx: only true modality rejections (400/404/422) qualify —
 * 429/402 bodies commonly echo vision-slug model names, so rate-limit and
 * payment failures keep the generic path. 413 counts too: with parts sent, the
 * payload overflow was caused by the images. Status-less shapes (a 200 response
 * wrapping {"error":{...}} surfaces as "OpenRouter/Local AI Provider Error: …")
 * fall back to the phrase test alone.
 */
function isVisionRejection(error: unknown, imageParts: ImagePart[]): boolean {
    if (imageParts.length === 0 || !(error instanceof Error)) return false;
    const status = error.message.match(/\((4\d{2})\)/)?.[1];
    if (status) {
      if (status === "413") return true;
      if (![400, 404, 422].includes(Number(status))) return false;
    }
    return VISION_REJECTION_RE.test(error.message);
}

/** Honest per-expert failure message for vision-rejecting models (SPEC §B4). */
function visionRejectionMessage(expertName: string): string {
    return `⚠️ ${expertName} could not analyze the image — this model doesn't accept image input. Try a vision-capable model (e.g. switch this expert to one, or use BYOK).`;
}

/**
 * G9 legibility: the structural slice of a stored Insight the carried-forward
 * block needs (a plain Insight satisfies this). id/createdAt are optional so
 * synthetic entries remain testable; the latest-insight pick falls back
 * through id → createdAt → insertion order.
 */
export interface PriorDecisionInsight {
    title: string;
    // Nullable to accept the drizzle select type of the insights.points
    // array column directly; non-array values are filtered out below.
    points: string[] | null | undefined;
    id?: number;
    createdAt?: Date | string | null;
}

/**
 * G9 legibility: build the compact "PRIOR DECISIONS" system block injected
 * into expert turns so the council builds on settled decisions from a prior
 * sequence instead of re-litigating them. Zero extra model calls — the block
 * is assembled from the insights already stored by generateInsights.
 *
 * Pure and unit-testable. Returns the block for the LATEST insight (highest
 * id, else newest createdAt, else last array entry — storage order is not
 * relied upon), or null when there is nothing usable. The whole block is
 * truncated to PRIOR_DECISIONS_MAX_CHARS via the shared truncator.
 */
export function buildPriorDecisionsBlock(insights: PriorDecisionInsight[]): string | null {
    if (!Array.isArray(insights) || insights.length === 0) return null;
    const withPoints = insights.filter(
        (i) => i && Array.isArray(i.points) && i.points.some((p) => typeof p === "string" && p.trim())
    );
    if (withPoints.length === 0) return null;
    const rank = (i: PriorDecisionInsight): number => {
        if (typeof i.id === "number") return i.id;
        const t = i.createdAt ? new Date(i.createdAt).getTime() : 0;
        return Number.isNaN(t) ? 0 : t;
    };
    const latest = withPoints.reduce((a, b) => (rank(b) >= rank(a) ? b : a));
    // The filter above guarantees an array, but narrowing doesn't survive
    // reduce — assert it locally.
    const latestPoints: string[] = Array.isArray(latest.points) ? latest.points : [];
    const bullets = latestPoints
        .filter((p) => typeof p === "string" && p.trim())
        .map((p) => `- ${p.trim()}`);
    if (bullets.length === 0) return null;
    return truncateForModel(
        `PRIOR DECISIONS (settled in an earlier round — do not re-litigate; build on these):\n${bullets.join("\n")}`,
        PRIOR_DECISIONS_MAX_CHARS
    );
}

// Function to generate response for a single expert WITH STREAMING
// Calls onToken for each token chunk, returns the final InsertMessage
export async function getExpertResponseStream(
  expert: Expert, 
  history: Message[], 
  referenceMessageContent: string, 
  files: File[],
  availableRoles: string[],
  onToken: (token: string) => void,
  deliverableRequest?: DeliverableGenerationRequest,
): Promise<InsertMessage> { 
  console.log(`[STREAM] Generating streaming response for expert: ${expert.name} (${expert.role})`);
  
  // Fetch farm profile and weather for context
  const conversation = await storage.getConversation(expert.conversationId);
  let farmContext = "";
  let weatherContext = "";
  if (conversation) {
    try {
      const profile = await storage.getFarmProfile(conversation.userId);
      if (profile && (profile.location || profile.crops?.length)) {
        farmContext = `Farm: ${profile.farmName}\nLocation: ${profile.location}\nAcres: ${profile.acres || 'N/A'}\nCrops: ${(profile.crops || []).join(', ') || 'N/A'}\nSoil Type: ${profile.soilType || 'N/A'}\nWater Source: ${profile.waterSource || 'N/A'}\nClimate Zone: ${profile.climateZone || 'N/A'}\nHardiness Zone: ${profile.hardinessZone || 'N/A'}`;
        
        // Fetch weather if coords available
        if (profile.lat && profile.lng) {
          const { getWeatherForFarm, formatWeatherContext } = await import('./weather');
          const weather = await getWeatherForFarm(profile.lat, profile.lng);
          if (weather.ok) {
            weatherContext = formatWeatherContext(weather.data);
          }
        }
      }
    } catch (err) {
      console.warn('[STREAM] Could not fetch farm/weather context:', (err as Error).message);
    }
  }
  
  const systemPrompt = generateSystemPrompt(expert, availableRoles, farmContext, weatherContext, conversation?.charter ?? null);

  const messages: AIMessage[] = [
    { role: "system", content: systemPrompt }
  ];

  const { context: fileContext, imageParts } = await buildAttachedFilesContext(files, history);
  if (fileContext) {
     messages.push({ role: "system", content: fileContext });
  }

   messages.push(...history.map(msg => ({
      role: mapDbRoleToApiRole(msg.role),
      content: truncateForModel(msg.content)
   })).slice(-15));

   // G9 legibility: carried-forward context — the latest insight from a prior
   // sequence rides along as a compact system block (zero extra model calls).
   // Optional context: any storage hiccup is logged and skipped, never fatal.
   try {
     const priorInsights = await storage.getConversationInsights(expert.conversationId);
     const priorDecisionsBlock = buildPriorDecisionsBlock(priorInsights ?? []);
     if (priorDecisionsBlock) {
       messages.push({ role: "system", content: priorDecisionsBlock });
     }
   } catch (priorErr) {
     console.warn("[STREAM] Could not load prior decisions:", (priorErr as Error).message);
   }

   // With image parts present, the user message becomes a multimodal content
   // array. The 12k-char truncation applies to the TEXT part only — the
   // base64 image parts are appended verbatim, never truncated.
   // Core tools: optional research phase (search / fetch) before answering.
   const toolRun = await runExpertToolPhase(expert, referenceMessageContent, conversation?.userId);
   if (toolRun) messages.push({ role: "system", content: formatToolResultsForPrompt(toolRun) });

   const userText = truncateForModel(referenceMessageContent);
   messages.push(
      imageParts.length > 0
        ? { role: "user", content: [{ type: "text", text: userText }, ...imageParts] }
        : { role: "user", content: userText }
   );

   console.log(`[STREAM] Sending ${messages.length} messages to LLM for ${expert.role}${imageParts.length > 0 ? ` (with ${imageParts.length} image part${imageParts.length > 1 ? "s" : ""})` : ""}.`);

  let streamFilter: TrailingStanceStreamFilter | null = null;
  try {
    let response: AIModelResponse;
    let stance: MessageStance | null = null;
    
    if (expert.role === "Research Analyst") {
      // Use OpenRouter streaming for Research Analyst (Perplexity optional)
      if (process.env.PERPLEXITY_API_KEY && process.env.PERPLEXITY_API_KEY.length > 10) {
        response = await callPerplexityAPI(referenceMessageContent, messages);
        stance = stripExpertStance(response, expert.role);
        onToken(response.message.content);
      } else {
        console.log("[STREAM] No Perplexity key — Research Analyst using OpenRouter streaming");
        streamFilter = new TrailingStanceStreamFilter(onToken);
        response = await callOpenRouterAPIStream(
          messages,
          expert.model,
          streamFilter ? token => streamFilter!.push(token) : onToken,
          conversation?.userId,
          paidWebPluginEnabled(),
        );
        streamFilter?.finish();
        stance = stripExpertStance(response, expert.role);
      }
    } 
    else if (expert.role === "File Creator") {
      // File Creator needs full response to parse JSON — use non-streaming
      const request = await prepareFileCreatorRequest(expert, messages, deliverableRequest);
      response = await callOpenRouterAPI(messages, expert.model, conversation?.userId);
      requireNonEmptyAssistantContent(response);
      stance = stripExpertStance(response, expert.role);
      const saved = await saveGeneratedDeliverable(response.message.content, expert, request);
      response.message.content = deliverableSuccessMessage(saved, request);
      onToken(response.message.content);
    }
    else {
      // MAIN PATH: Streaming via OpenRouter
      streamFilter = expert.role === "Moderator" ? null : new TrailingStanceStreamFilter(onToken);
      response = await callOpenRouterAPIStream(
        messages,
        expert.model,
        streamFilter ? token => streamFilter!.push(token) : onToken,
        conversation?.userId,
      );
      streamFilter?.finish();
      stance = stripExpertStance(response, expert.role);
    }
    
    requireNonEmptyAssistantContent(response);
    console.info(`[MODEL_RESPONSE] ${JSON.stringify({ conversationId: expert.conversationId, role: expert.role, requestedModel: expert.model, actualModel: response.providerModel ?? expert.model })}`);
    // Deliverable blocks are pulled out before artifact extraction so tables
    // inside a document stay in the document.
    const deliverableSplit = expert.role === "File Creator" || expert.role === "Moderator"
      ? { deliverable: null, cleanContent: response.message.content }
      : extractDeliverable(response.message.content);
    const extracted = extractArtifacts(deliverableSplit.cleanContent);
    const allowedChartUrls = toolRun?.sources.map(src => src.url) ?? [];
    const { kept: artifacts, dropped: droppedCharts } = filterChartArtifacts(extracted.artifacts, allowedChartUrls);
    if (droppedCharts) console.log(`[CHARTS] dropped ${droppedCharts} unsourced chart(s) from ${expert.role}`);
    const finalized = expert.role === "File Creator" || expert.role === "Moderator"
      ? { content: extracted.cleanContent, addition: "" }
      : await finalizeExpertTools(expert, extracted.cleanContent, toolRun, deliverableSplit.deliverable, history);
    if (finalized.addition) onToken(finalized.addition);
    const cleanContent = finalized.content;
    const researchAnswer = expert.role === "Research Analyst"
      ? appendRetrievedCitationUrls(cleanContent, response.citations)
      : { content: cleanContent, addition: "" };
    if (researchAnswer.addition) onToken(researchAnswer.addition);

    const streamedMessage: InsertMessage = {
      conversationId: expert.conversationId,
      expertId: expert.id,
      userId: null,
      content: researchAnswer.content,
      role: "assistant",
      expertName: expert.name,
      expertRole: expert.role,
      artifacts: artifacts,
      // G4: parse the @-tags the model actually wrote so the orchestrator
      // can route on them (and the client can render chips) without
      // re-parsing the stored content.
      mentions: extractMentions(cleanContent, availableRoles),
      stance,
    };
    const pendingDoc = pendingDeliverableFor.get(expert);
    if (pendingDoc) {
      pendingDeliverableFor.delete(expert);
      pendingDeliverableByMessage.set(streamedMessage, { expert, deliverable: pendingDoc });
    }
    return streamedMessage;

  } catch (error) {
    console.error(`[STREAM] Response generation failed for expert ${expert.name}`);
    streamFilter?.finish();
    const errorMsg = expertResponseErrorMessage(error, expert.name, imageParts);
    onToken(errorMsg); // Show error inline
    return {
      conversationId: expert.conversationId,
      expertId: expert.id,
      userId: null,
      content: errorMsg,
      role: "assistant",
      expertName: expert.name,
      expertRole: expert.role,
      stance: null,
    };
  }
}

// Function to generate response for a single expert (NON-STREAMING — kept for backward compat)
export async function getExpertResponse(
  expert: Expert, 
  history: Message[], 
  referenceMessageContent: string, 
  files: File[],
  availableRoles: string[],
  deliverableRequest?: DeliverableGenerationRequest,
): Promise<InsertMessage> { 
  console.log(`Generating response for expert: ${expert.name} (${expert.role})`);
  // G6: fetch the conversation for its council charter (farm/weather context
  // is only wired into the streaming path).
  const conversation = await storage.getConversation(expert.conversationId);
  const systemPrompt = generateSystemPrompt(expert, availableRoles, undefined, undefined, conversation?.charter ?? null);
  
  const messages: AIMessage[] = [
    { role: "system", content: systemPrompt }
  ];

  const { context: fileContext, imageParts } = await buildAttachedFilesContext(files, history);
  if (fileContext) {
     messages.push({
         role: "system",
         content: fileContext
     });
  }

   messages.push(...history.map(msg => ({
      role: mapDbRoleToApiRole(msg.role),
      content: truncateForModel(msg.content)
   })).slice(-15));

   // G9 legibility: same carried-forward PRIOR DECISIONS block as the
   // streaming path. Optional context: storage hiccups are skipped.
   try {
     const priorInsights = await storage.getConversationInsights(expert.conversationId);
     const priorDecisionsBlock = buildPriorDecisionsBlock(priorInsights ?? []);
     if (priorDecisionsBlock) {
       messages.push({ role: "system", content: priorDecisionsBlock });
     }
   } catch (priorErr) {
     console.warn("Could not load prior decisions:", (priorErr as Error).message);
   }

   // With image parts present, the user message becomes a multimodal content
   // array. The 12k-char truncation applies to the TEXT part only — the
   // base64 image parts are appended verbatim, never truncated.
   const userText = truncateForModel(referenceMessageContent);
   messages.push(
      imageParts.length > 0
        ? { role: "user", content: [{ type: "text", text: userText }, ...imageParts] }
        : { role: "user", content: userText }
   );

   console.log(`[DEBUG] Sending ${messages.length} messages to LLM for ${expert.role}${imageParts.length > 0 ? ` (with ${imageParts.length} image part${imageParts.length > 1 ? "s" : ""})` : ""}.`);

  try {
    let response: AIModelResponse;
    let stance: MessageStance | null = null;
    
    if (expert.role === "Research Analyst") {
      if (process.env.PERPLEXITY_API_KEY) {
        response = await callPerplexityAPI(referenceMessageContent, messages);
      } else {
        response = await callOpenRouterAPI(messages, expert.model, conversation?.userId, paidWebPluginEnabled());
      }
    } 
    else if (expert.role === "File Creator") {
       const request = await prepareFileCreatorRequest(expert, messages, deliverableRequest);
       response = await callOpenRouterAPI(messages, expert.model, conversation?.userId);
       requireNonEmptyAssistantContent(response);
       stance = stripExpertStance(response, expert.role);
       const saved = await saveGeneratedDeliverable(response.message.content, expert, request);
       response.message.content = deliverableSuccessMessage(saved, request);
    }
    else {
      response = await callOpenRouterAPI(messages, expert.model, conversation?.userId);
    }

    if (expert.role !== "File Creator") {
      stance = stripExpertStance(response, expert.role);
    }
    
    requireNonEmptyAssistantContent(response);
    const extractedNonStream = extractArtifacts(response.message.content);
    const { kept: artifacts } = filterChartArtifacts(extractedNonStream.artifacts, []);
    const cleanContent = extractedNonStream.cleanContent;
    const researchAnswer = expert.role === "Research Analyst"
      ? appendRetrievedCitationUrls(cleanContent, response.citations)
      : { content: cleanContent, addition: "" };

    return {
      conversationId: expert.conversationId,
      expertId: expert.id,
      userId: null,
      content: researchAnswer.content,
      role: "assistant",
      expertName: expert.name,
      expertRole: expert.role,
      artifacts: artifacts,
      // G4: parse the @-tags the model actually wrote so the orchestrator
      // can route on them (and the client can render chips) without
      // re-parsing the stored content.
      mentions: extractMentions(cleanContent, availableRoles),
      stance,
    };

  } catch (error) {
    console.error(`Response generation failed for expert ${expert.name}`);
    const errorMsg = expertResponseErrorMessage(error, expert.name, imageParts);
    return {
      conversationId: expert.conversationId,
      expertId: expert.id,
      userId: null,
      content: errorMsg,
      role: "assistant",
      expertName: expert.name,
      expertRole: expert.role,
      stance: null,
    };
  }
}

/**
 * G8 aux-call hygiene: resolve the model for auxiliary (non-expert-turn) LLM
 * calls — insight extraction and the Moderator's next-speaker suggestion.
 * Precedence: the Moderator expert's own model → DEFAULT_AUX_MODEL → the first
 * expert's model. Null means nothing resolvable: callers must skip the aux
 * call (or treat it as failed) instead of dialing a hardcoded legacy slug
 * that is likely dead on fresh installs. Whitespace-only values count as
 * empty; the returned slug is trimmed.
 */
export function resolveAuxModel(
  moderatorModel: string | null | undefined,
  firstExpertModel: string | null | undefined
): string | null {
  if (moderatorModel?.trim()) return moderatorModel.trim();
  const envModel = process.env.DEFAULT_AUX_MODEL;
  if (envModel && envModel.trim()) return envModel.trim();
  if (firstExpertModel?.trim()) return firstExpertModel.trim();
  return null;
}

/** Build the closing prompt from the latest expert stance ledger and G12 questions. */
export function buildClosingSynthesisPrompt(
  stanceLedger: Record<string, MessageStance | null> = {},
  openQuestions: OpenQuestion[] = [],
  charter?: string | null,
): string {
  const stanceEntries = Object.entries(stanceLedger).map(([expertRole, stance]) => ({
    expertRole,
    stance: stance?.stance ?? null,
    confidence: stance?.confidence ?? null,
    position: stance?.position ?? null,
  }));
  const hasNonAbstainingStance = Object.values(stanceLedger).some(
    stance => stance !== null && stance.stance !== "abstain",
  );
  const openQuestionEntries = openQuestions.map(question => ({
    expertRole: question.expertRole,
    question: question.question,
    assumption: question.assumption,
    status: question.status,
    createdAt: question.createdAt instanceof Date ? question.createdAt.toISOString() : question.createdAt,
  }));

  return `The discussion has run its course. Write a concise closing synthesis that helps the farmer act on the outcome.

Use exactly these five section headings, in this order, and do not add any other headings:
## Verdict
## Consensus
## Dissent
## Open questions for you
## Assumptions awaiting confirmation

Base the synthesis on the discussion, the latest structured stance ledger, and every currently open question listed below. State concrete decisions and next actions where the discussion supports them. In Dissent, name each expert role from the ledger and state that expert's recorded position when positions disagree or qualify the outcome. Do not claim consensus unless the discussion supports it; describe disagreement honestly.

Latest expert stance ledger (null means no valid structured stance was recorded):
${JSON.stringify(stanceEntries, null, 2)}

Current open G12 questions (include every item under the matching headings; do not silently drop any):
${JSON.stringify(openQuestionEntries, null, 2)}

${hasNonAbstainingStance
    ? "Use the stances as evidence, while reflecting any uncertainty or dissent."
    : "No expert has a non-abstaining structured stance. The Verdict must be conditional or unresolved and explicitly state that there is no expert consensus. Do not invent consensus."}
${charter?.trim()
    ? `Measure the outcome against the council charter, including its goal and stop criteria:\n${charter.trim()}`
    : ""}

Under “Open questions for you,” list the open questions for the farmer. Under “Assumptions awaiting confirmation,” list their paired assumptions. If a list is empty, say that none remain.`;
}

// Function to generate insights
export async function generateInsights(conversationId: number, broadcastFn?: (convId: number, data: any) => void): Promise<void> {
  try {
    const messages = await storage.getConversationMessages(conversationId);
    if (messages.length < 3) return;
    
    const historyText = messages
      .slice(-20)
      .map(m => `${m.expertName || m.role}: ${truncateForModel(m.content)}`)
      .join("\n");
    
    const insightPrompt = `
    Based on the following agricultural conversation transcript, identify 1-3 key insights, recommendations, or unresolved questions. Be concise.
    
    Transcript:
    ${historyText}
    
    Format your response STRICTLY as a JSON object with this structure:
    {
      "title": "Brief overall topic",
      "points": ["Insight/Recommendation 1", "Insight/Recommendation 2", "Insight/Recommendation 3"]
    }
    Only output the JSON object.
    `;
    
    // G8: resolve the insights model dynamically (Moderator's model →
    // DEFAULT_AUX_MODEL → first expert's model). Nothing resolvable means no
    // insights: log and return instead of calling a dead legacy slug.
    const experts = await storage.getConversationExperts(conversationId);
    const moderatorExpert = experts.find(e => e.role === 'Moderator') ?? null;
    const firstExpertModel = experts.find(e => e.role !== 'Moderator')?.model ?? null;
    const auxModel = resolveAuxModel(moderatorExpert?.model ?? null, firstExpertModel);
    if (!auxModel) {
      console.error(`generateInsights: no aux model could be resolved for conversation ${conversationId} (no Moderator model, DEFAULT_AUX_MODEL unset, roster empty) — skipping insights.`);
      return;
    }

    const conversation = await storage.getConversation(conversationId);
    const response = await callOpenRouterAPI([
      { role: "system", content: "You extract key insights from agricultural conversations. Respond only with the requested JSON format." },
      { role: "user", content: insightPrompt }
    ], auxModel, conversation?.userId);
    
    try {
      const insightData = JSON.parse(response.message.content);
      
      if (insightData.title && Array.isArray(insightData.points) && insightData.points.length > 0) {
        console.log(`Storing insights for conversation ${conversationId}:`, insightData);
        await storage.createInsight({ 
          conversationId,
          title: insightData.title,
          points: insightData.points
        });
        if (broadcastFn) {
          broadcastFn(conversationId, { type: "insights" });
        }
      } else {
         console.warn(`generateInsights: Received invalid JSON structure for ${conversationId}`, insightData);
      }
    } catch (e) {
      console.error(`generateInsights: Error parsing insights JSON for ${conversationId}:`, e, "\nRaw Response:", response.message.content);
    }
  } catch (error) {
    console.error(`generateInsights: Error generating insights for ${conversationId}:`, error);
  }
}

// New function to ask the Moderator who should speak next
export async function getModeratorNextSpeakerSuggestion(
    moderatorExpert: ModeratorContext,
    history: Message[],
    availableRoles: string[],
    farmerJustSpoke = false,
    options: {
      turnNumber?: number;
      turnBudget?: number;
      stanceLedger?: Record<string, MessageStance | null>;
    } = {}
): Promise<string | null> {
    console.log("Asking Moderator for next speaker suggestion...");
    try {
        // G6: the speak-next / conclude judgment is charter-aware — the Moderator
        // weighs the charter's goal and stop criteria.
        const conversation = await storage.getConversation(moderatorExpert.conversationId);
        const charter = conversation?.charter ?? null;
        const openQuestions = await storage.listOpenQuestions(moderatorExpert.conversationId);
        const expertRoles = availableRoles.filter(role => role !== "Moderator");
        const moderatorSystemPrompt = generateSystemPrompt(moderatorExpert, expertRoles, undefined, undefined, charter);
        const turnBudget = Number.isInteger(options.turnBudget) && (options.turnBudget ?? 0) > 0
            ? options.turnBudget!
            : 25;
        const turnNumber = Number.isInteger(options.turnNumber) && (options.turnNumber ?? 0) > 0
            ? Math.min(options.turnNumber!, turnBudget)
            : 1;
        let queryPrompt = `This is turn ${turnNumber} of ${turnBudget}. Based on the recent conversation history, choose how the council should proceed. Available expert roles: [${expertRoles.join(', ')}]. Respond with exactly one of these choices: 'Continue' to keep the discussion moving and let the next speaker be chosen by round-robin; 'Go deeper: <available role>' to direct the next contribution to one of those roles; or 'Conclude' if the discussion has run its course, the question is resolved, decisions are made, and further turns would only repeat the table. When continuing, prefer the role that best advances resolution or useful new insights. If deeper analysis is useful, name that role after 'Go deeper:'.`;
        const currentStances = Object.entries(options.stanceLedger ?? {}).map(([expertRole, stance]) => ({
            expertRole,
            stance: stance?.stance ?? null,
            confidence: stance?.confidence ?? null,
            position: stance?.position ?? null,
        }));
        queryPrompt += ` Latest expert stances by role (null means no valid stance was recorded): ${JSON.stringify(currentStances)}.`;
        queryPrompt += ` Current unanswered farmer questions: ${JSON.stringify(openQuestions.map(question => ({
            expertRole: question.expertRole,
            question: question.question,
            assumption: question.assumption,
        })))}. Prefer a role that can address an unresolved question or substantive disagreement. Suggest Conclude only when the discussion and charter provide evidence that the goal and stop criteria are satisfied; do not infer consensus from missing or abstaining stances.`;
        if (charter?.trim()) {
            queryPrompt += ` The council charter in your instructions states this roundtable's goal and stop criteria — factor them into the decision.`;
        }
        if (farmerJustSpoke) {
            queryPrompt += ` The farmer just spoke. Treat the farmer's latest message as new input to the discussion and choose the expert best positioned to respond to it or advance the room.`;
        }
        const linkedAnswer = [...history].reverse().find(
            message => message.role === "user" && Number.isInteger(message.answersQuestionId),
        );
        if (linkedAnswer?.answersQuestionId !== null && linkedAnswer?.answersQuestionId !== undefined) {
            const question = await storage.getOpenQuestion(linkedAnswer.answersQuestionId);
            if (question?.status === "answered" && question.answerMessageId === linkedAnswer.id) {
                queryPrompt += ` The farmer answered the open question "${question.question}": "${linkedAnswer.content}". Revisit any assumptions that conflict with this answer.`;
            }
        }

        const messages: AIMessage[] = [
            { role: "system", content: moderatorSystemPrompt },
            ...history.slice(-6).map(msg => ({
                role: mapDbRoleToApiRole(msg.role),
                content: truncateForModel(msg.content)
            })),
            { role: "user", content: queryPrompt }
        ];

        // G8: resolve this aux call's model dynamically (Moderator's model →
        // DEFAULT_AUX_MODEL → first expert's model, via the conversation's
        // expert roster in order — experts[0] is the first active expert).
        // Nothing resolvable behaves exactly like a failed call: return null so
        // the orchestrator falls back to round-robin.
        const experts = await storage.getConversationExperts(moderatorExpert.conversationId);
        const firstExpertModel = experts.find(expert => expert.role !== "Moderator")?.model ?? null;
        const auxModel = resolveAuxModel(moderatorExpert.model, firstExpertModel);
        if (!auxModel) {
            console.error("getModeratorNextSpeakerSuggestion: no aux model could be resolved (Moderator has no model, DEFAULT_AUX_MODEL unset, roster empty) — falling back to round-robin.");
            return null;
        }

        const response = await callOpenRouterAPI(messages, auxModel, conversation?.userId);
        const responseContent = response?.message?.content;
        if (typeof responseContent !== "string" || !responseContent.trim()) {
            console.warn("Moderator returned no next-speaker text. Falling back to round-robin.");
            return null;
        }
        const rawSuggestion = responseContent.trim().replace(/\.$/, '').trim();
        let suggestedRole: string | null = null;

        if (rawSuggestion.toLowerCase() === 'continue') {
            suggestedRole = 'RoundRobin';
        } else if (rawSuggestion.toLowerCase() === 'conclude') {
            suggestedRole = 'Conclude';
        } else if (rawSuggestion === 'RoundRobin') {
            // Keep accepting the legacy response while newer prompts ask for
            // the clearer "Continue" choice.
            suggestedRole = 'RoundRobin';
        } else {
            const goDeeperMatch = rawSuggestion.match(/^Go deeper:\s*(.+)$/i);
            const requestedRole = goDeeperMatch?.[1]?.trim();
            if (requestedRole && expertRoles.includes(requestedRole)) {
                suggestedRole = requestedRole;
            } else if (!goDeeperMatch && expertRoles.includes(rawSuggestion)) {
                // Existing providers may still return a plain role name.
                suggestedRole = rawSuggestion;
            }
        }

        if (suggestedRole) {
            console.log(`Moderator suggested next speaker: ${suggestedRole}`);
            return suggestedRole;
        }
        console.warn(`Moderator suggested an invalid role: '${rawSuggestion}'. Falling back.`);
        return null;
    } catch (error) {
        console.error("Error preparing or querying Moderator for next speaker:", error);
        return null;
    }
}

/**
 * G5 semantic conclusion: after the Moderator answers 'Conclude', stream the
 * council's closing synthesis as one full Moderator turn. Broadcasts the same
 * lifecycle as a normal expert turn (expert_stream_start → tokens →
 * expert_stream_done with the stored message) and persists the message with
 * isSynthesis: true so the client (and history) can tell it apart. Never
 * throws — provider failures store an honest "(Error generating response …)"
 * assistant message (still flagged isSynthesis) and broadcast done.
 *
 * G6: charter-aware — the conversation's council charter is injected into the
 * Moderator's system prompt and the closing prompt, so the summary honors the
 * charter's goal and stop criteria.
 */
export async function generateClosingSynthesis(
  conversationId: number,
  moderatorExpert: ModeratorContext,
  broadcastFn: (convId: number, data: any) => void,
  stanceLedger: Record<string, MessageStance | null> = {},
): Promise<void> {
  console.log(`[SYNTHESIS] Generating closing synthesis for conversation ${conversationId}`);
  try {
    const history = await storage.getConversationMessages(conversationId);
    const experts = await storage.getConversationExperts(conversationId);
    const openQuestions = await storage.listOpenQuestions(conversationId);
    const availableRoles = experts.map(e => e.role).filter(role => role !== "Moderator");
    const conversation = await storage.getConversation(conversationId);
    const charter = conversation?.charter ?? null;
    const systemPrompt = generateSystemPrompt(moderatorExpert, availableRoles, undefined, undefined, charter);
    const firstExpertModel = experts.find(expert => expert.role !== "Moderator")?.model ?? null;
    const closingModel = resolveAuxModel(moderatorExpert.model, firstExpertModel);

    const closingPrompt = buildClosingSynthesisPrompt(stanceLedger, openQuestions, charter);

    const messages: AIMessage[] = [
      { role: "system", content: systemPrompt },
      ...history.map(msg => ({
        role: mapDbRoleToApiRole(msg.role),
        content: truncateForModel(msg.content)
      })).slice(-15),
      { role: "user", content: closingPrompt }
    ];

    broadcastFn(conversationId, {
      type: "expert_stream_start",
      expertId: moderatorExpert.id,
      expertName: moderatorExpert.name,
      expertRole: "Moderator",
    });

    // G8/G10: resolve the Moderator's model, configured aux fallback, then
    // first council expert. If none is available, the honest-error path below
    // persists and broadcasts a closing failure instead of using a dead slug.
    if (!closingModel) {
      throw new Error("No auxiliary model could be resolved for the Moderator closing synthesis.");
    }
    const response = await callOpenRouterAPIStream(messages, closingModel, (token) => {
      broadcastFn(conversationId, {
        type: "expert_stream_token",
        expertId: moderatorExpert.id,
        token,
      });
    }, conversation?.userId);
    const content = response.message.content;

    const storedMessage = await storage.createMessage({
      conversationId,
      expertId: moderatorExpert.id,
      userId: null,
      content,
      role: "assistant",
      expertName: moderatorExpert.name,
      expertRole: moderatorExpert.role,
      isSynthesis: true,
      mentions: extractMentions(content, availableRoles),
    });
    broadcastFn(conversationId, {
      type: "expert_stream_done",
      expertId: moderatorExpert.id,
      message: storedMessage,
    });
    console.log(`[SYNTHESIS] Closing synthesis stored and broadcast for conversation ${conversationId}`);
  } catch (error) {
    console.error(`[SYNTHESIS] Error generating closing synthesis for conversation ${conversationId}:`, error);
    // Honest-error convention: persist the failure (survives refetches), keep
    // the synthesis flag, and still close the stream so the client is never
    // left with a spinner. Re-throw nothing — the orchestrator chain continues
    // into the natural-end cleanup.
    const errorMsg = `(Error generating response from ${moderatorExpert.name}: ${error instanceof Error ? error.message : String(error)})`;
    broadcastFn(conversationId, {
      type: "expert_stream_token",
      expertId: moderatorExpert.id,
      token: errorMsg,
    });
    let storedMessage: Message | undefined;
    try {
      storedMessage = await storage.createMessage({
        conversationId,
        expertId: moderatorExpert.id,
        userId: null,
        content: errorMsg,
        role: "assistant",
        expertName: moderatorExpert.name,
        expertRole: moderatorExpert.role,
        isSynthesis: true,
      });
    } catch (storeError) {
      console.error("[SYNTHESIS] Failed to store synthesis error message:", storeError);
    }
    if (storedMessage) {
      broadcastFn(conversationId, {
        type: "expert_stream_done",
        expertId: moderatorExpert.id,
        message: storedMessage,
      });
    }
  }
}

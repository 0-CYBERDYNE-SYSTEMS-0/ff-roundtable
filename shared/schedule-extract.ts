/**
 * Schedule extraction — turns conversation artifacts (table/chart/json) and
 * File-Creator generated .md files into schedulable rows, plus the anchor-date
 * math that maps rows onto real calendar dates.
 *
 * Pure and conservative: anything that does not clearly look like a week or an
 * ISO date is skipped. No matches -> empty list -> the export route answers 422.
 */

import fs from "fs";
import { parseIsoDate } from "./calendar-date";
import path from "path";
import type { Artifact, File, Message } from "./schema";
import { addDaysIso } from "./ics";
import { stripMarkdownToText } from "./markdown";

export interface ScheduleRow {
  /** 1-based week number (W1 -> 1). */
  weekIndex?: number;
  /** Explicit ISO date "YYYY-MM-DD", used verbatim. */
  date?: string;
  /** Source title: artifact title or generated-file title. */
  title: string;
  /** Task text from the row ("Soil sampling"); preferred over the file slug for event titles. */
  task?: string;
  description: string;
}

/**
 * Only week-ish headers may anchor a weekIndex and only "date" may anchor a
 * real date. The broader chart-axis superset (day/time/month/stage/…) is
 * deliberately excluded: treating "Day 2" as week 2 fabricated events a week
 * apart, so non-week time axes are skipped entirely (never invent events).
 */
const WEEK_HEADER_KEYS = new Set(["week", "wk", "w"]);
const DATE_HEADER_KEYS = new Set(["date"]);

/**
 * The system prompt coaches emoji-decorated table headers ("| 🌱 Week |"), so
 * header matching strips everything but letters: "🗓️ Week" -> "week".
 */
function normalizeHeader(cell: string): string {
  return cell.toLowerCase().replace(/[^a-z]/g, "");
}

/** Strip markdown emphasis/emoji junk so "**Week 1**" parses as "Week 1". */
function stripCellDecorations(cell: string): string {
  return cell.replace(/[*_~]/g, "").trim();
}

/** Hard cap on exported events. */
export const MAX_SCHEDULE_ROWS = 60;


/**
 * Parse a week cell in one of the anchored forms "W1", "Week 2", "3" (and the
 * bare digit form the .md line regex captures). Anchoring keeps ordinary
 * time-axis values ("Day 1", "10:30", "March 15") from becoming week numbers.
 * Returns undefined for anything else or outside 1..53.
 */
export function parseWeekCell(cell: string): number | undefined {
  const match = stripCellDecorations(cell).match(/^(?:(?:w|wk|week)\.?\s*)?(\d{1,2})$/i);
  if (!match) return undefined;
  const n = Number(match[1]);
  return n >= 1 && n <= 53 ? n : undefined;
}

/**
 * Strict ISO calendar-date validation. Rejects garbage, out-of-range dates
 * ("2026-02-30") and non-padded forms ("2026-3-1").
 */
export { parseIsoDate } from "./calendar-date";

/**
 * Convention: "next Monday" is the first Monday STRICTLY AFTER today's UTC
 * date. On a Monday, the anchor is the following Monday (+7).
 */
export function nextMondayFrom(date: Date): string {
  const daysAhead = ((8 - date.getUTCDay()) % 7) || 7;
  return addDaysIso(date.toISOString().slice(0, 10), daysAhead);
}

/** Map a row onto a calendar date: explicit dates verbatim, weekIndex anchored. */
export function resolveRowStartDate(row: ScheduleRow, anchorIso: string): string {
  if (row.date) return row.date;
  const n = row.weekIndex ?? 1;
  return addDaysIso(anchorIso, (n - 1) * 7);
}

/** Generic extractor label that carries no information for a calendar user. */
const GENERIC_TABLE_TITLE_RE = /^Data Table \d+$/;

/**
 * SUMMARY format: "<source title> — Week N" (or the explicit date). When the
 * source title is still the generic "Data Table N" label, compose the summary
 * from the row's first meaningful description cell instead — "Soil test —
 * Week 1" reads like an event, "Data Table 1 — Week 1" does not.
 */
/** Calendar display name: the conversation title unless it is the default, else the plan's calendar or file title. */
export function calendarDisplayName(conversationTitle: string | null | undefined, messages: Message[], files: File[] = []): string {
  const t = (conversationTitle ?? "").trim();
  if (t && !/^(new conversation|untitled|roundtable)$/i.test(t)) return t;
  for (const m of messages ?? []) for (const a of (m as { artifacts?: Artifact[] }).artifacts ?? []) {
    if ((a as { type?: string }).type === "calendar" && a.title && !/^calendar$/i.test(a.title)) return humanizeTitle(a.title);
  }
  const plan = (files ?? []).find(f => !f.supersededAt && f.uploadedBy?.startsWith("Expert:") && /\.md$/i.test(f.filename));
  if (plan) return humanizeTitle(plan.filename.replace(/\.md$/i, ""));
  return t || "Roundtable calendar";
}

function humanizeTitle(slug: string): string {
  if (/\s/.test(slug)) return slug;
  const w = slug.replace(/[-_]+/g, " ").trim();
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** Notes never repeat the event title. */
export function notesWithoutTitle(description: string, title: string): string {
  const t = title.replace(/ — Week \d+$/, "").trim();
  if (!t) return description;
  const parts = description.split(" — ").map(p => p.trim()).filter(p => p && p.toLowerCase() !== t.toLowerCase());
  return parts.join(" — ");
}

const WARM_SEASON_RE = /\b(warm[- ]season|tomato(es)?|peppers?|squash|melons?|cucumbers?|beans?|corn|basil|eggplants?)\b/i;
/** Warm-season transplants / direct seeding go after the quoted last-frost average (+7 days), never before. */
export function afterLastFrost(summary: string, startDate: string, frostIso: string | undefined): string {
  if (!frostIso || !WARM_SEASON_RE.test(summary) || !/\b(transplant|set out|plant(ing)? out|direct[- ]seed|sow)\b/i.test(summary)) return startDate;
  const min = addDaysIso(frostIso, 7);
  return startDate < min ? min : startDate;
}

/** Final event list for any calendar surface: dates, frost rule, clean de-duplicated notes. */
export function finalizeCalendarEvents<T extends { summary: string; startDate: string; description: string }>(events: T[], frostIso: string | undefined): T[] {
  return events
    .map(e => ({ ...e, summary: capEventTitle(e.summary), startDate: afterLastFrost(e.summary, e.startDate, frostIso), description: notesWithoutTitle(e.description, e.summary) }))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

export function buildRowSummary(row: ScheduleRow): string {
  if (row.task) return row.weekIndex !== undefined && !row.date ? `${row.task} — Week ${row.weekIndex}` : row.task;
  if (GENERIC_TABLE_TITLE_RE.test(row.title.trim())) {
    const firstCell = row.description
      .split(" — ")
      .map((segment) =>
        segment
          .trim()
          .replace(/^[—–:\s]+/, "")
          .replace(/[—–:\s]+$/, ""),
      )
      .find((segment) => segment.length > 0);
    if (firstCell) {
      if (row.weekIndex !== undefined) return `${firstCell} — Week ${row.weekIndex}`;
      if (row.date) return `${firstCell} — ${row.date}`;
      return firstCell;
    }
  }
  if (row.weekIndex !== undefined) return `${row.title} — Week ${row.weekIndex}`;
  if (row.date) return `${row.title} — ${row.date}`;
  return row.title;
}


// ── timing cells (gate C r4) ─────────────────────────────────────────────────

/** Headers like "Trigger / timing", "When", "Window", "Target date". */
const TIMING_HEADER_RE = /(timing|when|window|schedule|timeframe|targetdate|duedate|dates?$)/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

export interface TimingContext {
  /** ISO date that "T" refers to (e.g. the stated target planting date). */
  anchorIso?: string;
  /** Today's date; month-day dates without a year resolve to their next occurrence. */
  todayIso: string;
}

function isoOf(y: number, m: number, d: number): string | undefined {
  return parseIsoDate(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
}

/** "April 20", "Apr 20, 2027", "20 April" → ISO; no year → next occurrence on/after today. */
export function parseMonthDay(text: string, todayIso: string): string | undefined {
  const a = text.match(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(\\d{4}))?`, "i"));
  const b = a ? null : text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\b(?:,?\\s*(\\d{4}))?`, "i"));
  const [monthName, day, year] = a ? [a[1], a[2], a[3]] : b ? [b[2], b[1], b[3]] : [];
  if (!monthName) return undefined;
  const m = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase()) + 1;
  const d = Number(day);
  if (year) return isoOf(Number(year), m, d);
  const ty = Number(todayIso.slice(0, 4));
  const thisYear = isoOf(ty, m, d);
  if (thisYear && thisYear >= todayIso) return thisYear;
  return isoOf(ty + 1, m, d);
}


const SEASONS: Record<string, [number, number]> = { spring: [3, 20], summer: [6, 21], fall: [9, 22], autumn: [9, 22], winter: [12, 21] };
const SEASON_PART: Record<string, number> = { early: 0, mid: 30, late: 60 };

/**
 * "this spring", "next fall", "early spring", "late summer 2027" → ISO start of
 * that season, never in the past: from Oct 2026, "this spring" is spring 2027.
 */
export function parseSeason(text: string, todayIso: string): string | undefined {
  const m = text.match(/\b(?:(this|next|coming)\s+)?(?:(early|mid|late)[- ]?)?(spring|summer|fall|autumn|winter)\b(?:\s+(\d{4}))?/i);
  if (!m) return undefined;
  const [mm, dd] = SEASONS[m[3].toLowerCase()];
  const offset = SEASON_PART[(m[2] ?? "early").toLowerCase()] ?? 0;
  const at = (y: number) => addDaysIso(isoOf(y, mm, dd)!, offset);
  if (m[4]) return at(Number(m[4]));
  const ty = Number(todayIso.slice(0, 4));
  let candidate = at(ty);
  if (candidate < todayIso) candidate = at(ty + 1);
  if (m[1]?.toLowerCase() === "next" && candidate === at(ty) && m[3].toLowerCase() !== "winter") {
    // "next spring" in February still means the coming one; only skip a season already under way.
  }
  return candidate;
}

/** "April", "early May" → the 1st/15th of the next occurrence of that month. */
export function parseMonthOnly(text: string, todayIso: string): string | undefined {
  const m = text.match(new RegExp(`\\b(?:(early|mid|late)[- ]?)?${MONTH_RE}\\b(?:\\s+(\\d{4}))?`, "i"));
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
  const day = ({ early: 1, mid: 15, late: 22 } as Record<string, number>)[(m[1] ?? "early").toLowerCase()] ?? 1;
  if (m[3]) return isoOf(Number(m[3]), month, day);
  const ty = Number(todayIso.slice(0, 4));
  const c = isoOf(ty, month, day)!;
  return c >= todayIso ? c : isoOf(ty + 1, month, day);
}

/** Future plans never land in the past: roll a stale year forward until it is on/after today. */
export function rollForwardIso(iso: string, todayIso: string): string {
  let out = iso;
  for (let i = 0; i < 5 && out < todayIso; i++) {
    const [y, m, d] = out.split("-").map(Number);
    out = isoOf(y + 1, m, d) ?? isoOf(y + 1, m, d - 1)!;
  }
  return out;
}

/** Event notes are plain text: no table pipes, separator runs or markdown leftovers. */
export function cleanEventNotes(text: string): string {
  return text
    .replace(/\s*\|\s*(\|\s*)*/g, " — ")
    .replace(/(?:\s*—\s*){2,}/g, " — ")
    .replace(/^[\s—–|]+|[\s—–|]+$/g, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
}

/** Week 1 anchor: the next occurrence of the stated anchor, else today. */
export function resolveScheduleAnchor(statedIso: string | undefined, todayIso: string): string {
  return statedIso ? rollForwardIso(statedIso, todayIso) : todayIso;
}

/** Finds the plan's stated anchor: "T = 2027-04-15", "T is April 25", "target planting date: May 1". */
export function findTimingAnchor(text: string, todayIso: string): string | undefined {
  const m = text.match(/\b(?:T\s*(?:=|:|is)|target (?:planting |seeding |start )?date\s*(?:=|:|is|of)?|planting date\s*(?:=|:|is))\s*([^\n|;.()]{3,40})/i);
  if (!m) return undefined;
  const iso = m[1].match(/\d{4}-\d{2}-\d{2}/);
  return iso ? parseIsoDate(iso[0]) : parseMonthDay(m[1], todayIso) ?? parseSeason(m[1], todayIso) ?? parseMonthOnly(m[1], todayIso);
}

/** One timing cell → an ISO date or week number; undefined when it is a condition ("when soil is fit"). */
export function parseTimingCell(cell: string, ctx: TimingContext): { date?: string; weekIndex?: number } | undefined {
  const text = stripCellDecorations(cell);
  const iso = text.match(/\d{4}-\d{2}-\d{2}/);
  if (iso && parseIsoDate(iso[0])) return { date: iso[0] };
  const rel = text.match(/\bT\s*([-+−–])\s*(\d{1,3})\s*(d|days?|w|wks?|weeks?)?\b/i);
  if (rel) {
    if (!ctx.anchorIso) return undefined;
    const n = Number(rel[2]) * (/^w/i.test(rel[3] ?? "") ? 7 : 1);
    return { date: addDaysIso(ctx.anchorIso, rel[1] === "+" ? n : -n) };
  }
  if (/^T$|\bT\s*(?:=|0)\b/.test(text) && ctx.anchorIso) return { date: ctx.anchorIso };
  const week = text.match(/\b(?:week|wk|w)\.?\s*(\d{1,2})\b/i);
  if (week) { const n = parseWeekCell(week[1]); if (n) return { weekIndex: n }; }
  const md = parseMonthDay(text, ctx.todayIso) ?? parseSeason(text, ctx.todayIso) ?? parseMonthOnly(text, ctx.todayIso);
  return md ? { date: md } : undefined;
}

/** Contiguous "|"-led line groups in markdown text. */
function markdownTableBlocks(content: string): string[] {
  const blocks: string[] = [];
  let cur: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().startsWith("|")) cur.push(line);
    else if (cur.length) { blocks.push(cur.join("\n")); cur = []; }
  }
  if (cur.length) blocks.push(cur.join("\n"));
  return blocks;
}

// ── table artifacts ──────────────────────────────────────────────────────────

/**
 * Split a markdown pipe table exactly the way ArtifactDisplay does:
 * lines -> split("|") -> drop empty cells -> trim.
 */
function splitMarkdownTable(content: string): string[][] {
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((row) =>
      row
        .split("|")
        .filter((cell) => cell.trim())
        .map((cell) => cell.trim()),
    );
}

function extractFromTable(artifact: Pick<Artifact, "content" | "title">, rows: ScheduleRow[], ctx?: TimingContext): void {
  const table = splitMarkdownTable(artifact.content);
  if (table.length < 2) return;
  const header = table[0];
  const weekCol = header.findIndex((cell) => WEEK_HEADER_KEYS.has(normalizeHeader(cell)));
  const dateCol = header.findIndex((cell) => DATE_HEADER_KEYS.has(normalizeHeader(cell)));
  if (weekCol === -1 && dateCol === -1) {
    // No Week/Date column: parse a timing column ("April 20 – May 20", "T-14", "Week 3").
    const timingCol = header.findIndex((cell) => TIMING_HEADER_RE.test(normalizeHeader(cell)));
    if (timingCol === -1 || !ctx) return;
    const title = artifact.title || "Schedule";
    for (const row of table.slice(1)) {
      if (!row[timingCol] || /^[-:\s]+$/.test(row[timingCol])) continue;
      const parsed = parseTimingCell(row[timingCol], ctx);
      if (!parsed) continue;
      const taskIdx = row.findIndex((cell, i) => i !== timingCol && calendarNotesText(cell).length > 0);
      const task = taskIdx === -1 ? undefined : cleanEventNotes(calendarNotesText(row[taskIdx])).split(" — ")[0].trim() || undefined;
      const description = cleanEventNotes(row.map((cell, i) => (i === taskIdx ? "" : i === timingCol ? `When: ${calendarNotesText(cell)}` : calendarNotesText(cell))).filter(Boolean).join(" — "));
      rows.push({ ...parsed, title, task, description });
    }
    return;
  }
  const title = artifact.title || "Schedule";
  for (const row of table.slice(1)) {
    const dateCell = dateCol !== -1 ? stripCellDecorations(row[dateCol]) : undefined;
    const weekCell = weekCol !== -1 ? stripCellDecorations(row[weekCol]) : undefined;
    const date = dateCell ? parseIsoDate(dateCell) ?? (ctx ? parseTimingCell(dateCell, ctx)?.date : undefined) : undefined;
    const weekIndex = weekCell ? parseWeekCell(weekCell) : undefined;
    if (date === undefined && weekIndex === undefined) continue;
    // .ics DESCRIPTION is plain text: strip markdown from each cell (the chat
    // UI renders the artifact itself — this is the export path only).
    const cells = row
      .filter((_, i) => i !== weekCol && i !== dateCol)
      .map((cell) => cleanEventNotes(calendarNotesText(cell)))
      .filter((cell) => cell.length > 0);
    const task = cells.length > 1 || ctx ? cells[0]?.split(" — ")[0].trim() || undefined : undefined;
    const description = cleanEventNotes(cells.join(" — "));
    rows.push({ weekIndex, date, title, task, description });
  }
}

/** Calendar notes keep resource URLs while removing Markdown decoration. */
function calendarNotesText(text: string): string {
  return stripMarkdownToText(text.replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)"));
}

// ── chart / json artifacts ───────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accept either a bare array or a { data: [...] } wrapper (chart shape). */
function extractObjectArray(source: unknown): Record<string, unknown>[] {
  if (Array.isArray(source)) return source.filter(isPlainObject);
  if (isPlainObject(source) && Array.isArray(source.data)) {
    return source.data.filter(isPlainObject);
  }
  return [];
}

function extractFromArrayData(data: Record<string, unknown>[], title: string, rows: ScheduleRow[]): void {
  for (const entry of data) {
    const keys = Object.keys(entry);
    const weekKey = keys.find((k) => WEEK_HEADER_KEYS.has(normalizeHeader(k)));
    const dateKey = keys.find((k) => DATE_HEADER_KEYS.has(normalizeHeader(k)));
    if (!weekKey && !dateKey) continue;
    const toCell = (key: string) => {
      const raw = entry[key];
      return typeof raw === "string" ? raw : String(raw ?? "");
    };
    const date = dateKey ? parseIsoDate(toCell(dateKey)) : undefined;
    const weekIndex = weekKey ? parseWeekCell(toCell(weekKey)) : undefined;
    if (date === undefined && weekIndex === undefined) continue;
    const description = keys
      .filter((k) => k !== weekKey && k !== dateKey)
      .map((k) => `${k}: ${calendarNotesText(String(entry[k] ?? ""))}`)
      .join("; ");
    rows.push({ weekIndex, date, title, description });
  }
}

// ── File-Creator .md files ───────────────────────────────────────────────────

const MD_WEEK_LINE_RE = /^(?:#{1,4}\s*|[-*]\s*|\*\*)?(?:week|wk\.?|w)\s*(\d{1,2})\b/i;
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}/;

function extractFromMarkdown(content: string, sourceTitle: string, rows: ScheduleRow[]): void {
  let current: ScheduleRow | null = null;

  const flush = () => {
    if (current) rows.push({ ...current, description: current.description.trimEnd() });
    current = null;
  };

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    const weekMatch = trimmed.match(MD_WEEK_LINE_RE);
    const dateMatch = weekMatch ? null : trimmed.match(ISO_DATE_RE);

    if (weekMatch || dateMatch) {
      flush();
      // Rest of the line (after the week prefix / date) describes the event.
      // Stripped to plaintext while emphasis pairs are still intact, then the
      // leftover separator/prefix junk is trimmed.
      const rest = calendarNotesText(
        weekMatch ? trimmed.slice(weekMatch[0].length) : trimmed.replace(ISO_DATE_RE, ""),
      )
        .replace(/^[\s—–:*\-]+/, "")
        .trim();
      const descriptionParts: string[] = [];
      if (rest) descriptionParts.push(rest);
      const row: ScheduleRow = {
        weekIndex: weekMatch ? parseWeekCell(weekMatch[1]) : undefined,
        date: dateMatch ? parseIsoDate(dateMatch[0]) : undefined,
        title: sourceTitle,
        description: descriptionParts.join(" "),
      };
      // A line that looked schedulable but parsed to neither a valid week nor
      // a valid date ("Week 99", "Due 2026-99-99") must not become a phantom
      // event anchored at Week 1.
      if (row.weekIndex !== undefined || row.date !== undefined) {
        current = row;
      }
      continue;
    }

    if (current && !trimmed && current.description && !current.description.endsWith("\n")) current.description += "\n";
    if (current && trimmed) {
      const line = calendarNotesText(trimmed);
      if (line) {
        const sep = current.description ? "\n" : "";
        current.description += sep + line;
      }
    }
  }
  flush();
}

// ── file reading ─────────────────────────────────────────────────────────────

/** Default disk reader: null on any error so unreadable files are skipped silently. */
function readLocalFile(absolutePath: string): string | null {
  try {
    return fs.readFileSync(absolutePath, "utf-8");
  } catch {
    return null;
  }
}

function readGeneratedFile(file: File, readFile: (p: string) => string | null): string | null {
  try {
    const relativePath = file.fileUrl.replace(/^\/+/, "");
    return readFile(path.join(process.cwd(), relativePath));
  } catch {
    return null;
  }
}

/** Latest anchor the conversation states ("Target planting date: April 25", "T = …"). */
/** "last frost Mar 25", "Mar 25 at 32°F (average last frost)" → next future occurrence of that date. */
export function findFrostAnchor(text: string, todayIso: string): string | undefined {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!/\bfrost|freeze|32\s*°?\s*F\b/i.test(line)) continue;
    // Prefer the date nearest the frost word within the same cell/sentence.
    for (const seg of line.split(/\||;|\. /)) {
      if (!/\bfrost|freeze|32\s*°?\s*F\b/i.test(seg)) continue;
      const iso = seg.match(/\d{4}-\d{2}-\d{2}/);
      const d = iso ? parseIsoDate(iso[0]) : parseMonthDay(seg, todayIso);
      if (d) return rollForwardIso(d, todayIso);
    }
  }
  return undefined;
}

/**
 * Week 1 anchor, in priority order (gate C r6):
 * 1) an explicit anchor or frost date in any text (next future occurrence);
 * 2) a season word ("this spring" → spring 2027 when asked in autumn);
 * 3) undefined → caller falls back to today.
 */
export function findPlanAnchor(texts: string[], todayIso: string): string | undefined {
  for (const t of texts) { const a = findTimingAnchor(t, todayIso); if (a) return rollForwardIso(a, todayIso); }
  for (const t of texts) { const a = findFrostAnchor(t, todayIso); if (a) return a; }
  for (const t of texts) {
    // Season words only (not "Week N" rows): the plan's seasonal start.
    const m = String(t ?? "").match(/\b(?:(?:this|next|coming)\s+)?(?:(?:early|mid|late)[- ]?)?(spring|summer|fall|autumn|winter)\b(?:\s+\d{4})?/i);
    if (m) { const a = parseSeason(m[0], todayIso); if (a) return a; }
  }
  return undefined;
}

function messageTexts(messages: Message[]): string[] {
  const out: string[] = [];
  for (const m of messages ?? []) {
    out.push(String((m as { content?: unknown }).content ?? ""));
    for (const a of m.artifacts ?? []) if (a.type === "table") out.push(a.content);
  }
  return out;
}

/** Markdown plan files (Expert-generated) as text, for anchoring. */
export function planFileTexts(files: File[], readFile: (absolutePath: string) => string | null = readLocalFile): string[] {
  const out: string[] = [];
  for (const file of files ?? []) {
    if (file.supersededAt || !file.uploadedBy?.startsWith("Expert:") || !file.filename.toLowerCase().endsWith(".md")) continue;
    const c = readGeneratedFile(file, readFile);
    if (c) out.push(c);
  }
  return out;
}

/** The Week-1 anchor saved with the conversation's first calendar artifact (gate C r7: one anchor per calendar). */
export function findPersistedCalendarAnchor(messages: Message[]): string | undefined {
  for (const m of messages ?? []) {
    for (const a of (m as { artifacts?: Artifact[] }).artifacts ?? []) {
      if ((a as { type?: string }).type !== "calendar") continue;
      try { const anchor = JSON.parse(a.content)?.anchor; if (typeof anchor === "string" && parseIsoDate(anchor)) return anchor; } catch { /* not JSON */ }
    }
  }
  return undefined;
}

export function findConversationAnchor(messages: Message[], todayIso: string, extraTexts: string[] = []): string | undefined {
  const persisted = findPersistedCalendarAnchor(messages);
  if (persisted) return persisted;
  return findPlanAnchor([...messageTexts(messages), ...extraTexts], todayIso);
}

// ── entry point ──────────────────────────────────────────────────────────────

/**
 * Extract schedulable rows from conversation messages (their artifacts) and
 * conversation files (Expert-generated .md plans), capped at MAX_SCHEDULE_ROWS.
 *
 * `readFile` is injectable for tests; the default reads from disk relative to
 * process.cwd() and skips files it cannot read.
 */
export function extractScheduleRows(
  messages: Message[],
  files: File[],
  readFile: (absolutePath: string) => string | null = readLocalFile,
  todayIso: string = new Date().toISOString().slice(0, 10),
): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  let anchorIso: string | undefined = findConversationAnchor(messages, todayIso, planFileTexts(files, readFile));

  for (const message of messages ?? []) {
    anchorIso = findTimingAnchor(String((message as { content?: unknown }).content ?? ""), todayIso) ?? anchorIso;
    for (const artifact of message.artifacts ?? []) {
      if (artifact.type === "table") {
        const ctx = { anchorIso: findTimingAnchor(artifact.content, todayIso) ?? anchorIso, todayIso };
        extractFromTable(artifact, rows, ctx);
      } else if (artifact.type === "chart" || artifact.type === "json") {
        try {
          const parsed = JSON.parse(artifact.content);
          // Visualization observations are not tasks, even when they have dates.
          if (parsed?.type === "vega-lite") continue;
          const data = extractObjectArray(parsed);
          extractFromArrayData(data, artifact.title || "Schedule", rows);
        } catch {
          // Not valid JSON — skip silently.
        }
      }
    }
  }

  for (const file of files ?? []) {
    if (file.supersededAt) continue;
    if (!file.uploadedBy.startsWith("Expert:")) continue;
    if (!file.filename.toLowerCase().endsWith(".md")) continue;
    const content = readGeneratedFile(file, readFile);
    if (!content) continue;
    const sourceTitle = file.filename.replace(/\.md$/i, "") || file.filename;
    // Calendar deliverables are usually a markdown table: read it as a table
    // (task text → title, cells → notes), then the prose "Week N" / date lines.
    const ctx = { anchorIso: findTimingAnchor(content, todayIso) ?? anchorIso, todayIso };
    for (const block of markdownTableBlocks(content)) {
      extractFromTable({ content: block, title: sourceTitle }, rows, ctx);
    }
    extractFromMarkdown(content.split(/\r?\n/).filter((l) => !l.trim().startsWith("|")).join("\n"), sourceTitle, rows);
  }

  // Plans are forward-looking: a stale year (2026-02-15 written in Oct 2026) rolls to its next occurrence.
  return rows.slice(0, MAX_SCHEDULE_ROWS).map((row) => (row.date ? { ...row, date: rollForwardIso(row.date, todayIso), description: cleanEventNotes(row.description) } : { ...row, description: cleanEventNotes(row.description) }));
}

// ── inline calendar (gate C r5) ──────────────────────────────────────────────

export interface InlineCalendarEvent { summary: string; startDate: string; description: string }

/** Event titles fit the 75-character calendar limit; longer ones end with an ellipsis. */
export const EVENT_TITLE_MAX = 75;
export function capEventTitle(title: string): string {
  const t = title.trim();
  if (t.length <= EVENT_TITLE_MAX) return t;
  let cut = t.slice(0, EVENT_TITLE_MAX - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd() + "\u2026";
}

/** Bumps whenever any message gains artifacts (inline calendar, tables): drives Week-1 refresh. */
export function planRevisionOf(messages: Array<{ id?: number; artifacts?: unknown[] | null }> | null | undefined): number {
  let n = 0;
  for (const m of messages ?? []) { const c = m.artifacts?.length ?? 0; if (c) n += c * 1000 + (m.id ?? 0); }
  return n;
}

/** The reply itself is a week-by-week plan (e.g. "planting calendar", "W3–W4" rows) even if the farmer never said "calendar". */
export function replyIsWeekPlan(reply: string): boolean {
  return /\b(calendar|schedule|week[- ]by[- ]week)\b/i.test(reply) && /(\bW(?:ee)?k?\s?\d+\b|\bWeek\s\d+)/.test(reply);
}

/** The farmer asked for something calendar-shaped. */
export function wantsCalendar(text: string): boolean {
  return /\b(calendar|schedule|dated plan|timeline|task plan|when should i)\b/i.test(text);
}

/**
 * Builds the compact calendar shown inside the chat message from this reply's
 * table artifacts and deliverable markdown. Same extraction, anchoring and
 * clock as the Calendar plan, so the inline list and the export agree.
 */
export function buildInlineCalendarArtifact(opts: {
  artifacts: Artifact[];
  deliverableMarkdown?: string;
  deliverableTitle?: string;
  contextText: string;
  todayIso: string;
  /** Anchor persisted with this conversation's calendar; when set it is used verbatim. */
  persistedAnchor?: string;
}): Artifact | null {
  const messages = [{ content: opts.contextText, artifacts: opts.artifacts }] as unknown as Message[];
  const files = opts.deliverableMarkdown
    ? ([{ filename: `${opts.deliverableTitle ?? "Calendar"}.md`, uploadedBy: "Expert:inline", fileUrl: "/inline.md" }] as unknown as File[])
    : [];
  const rows = extractScheduleRows(messages, files, () => opts.deliverableMarkdown ?? null, opts.todayIso);
  if (!rows.length) return null;
  const stated = findConversationAnchor(messages, opts.todayIso, opts.deliverableMarkdown ? [opts.deliverableMarkdown] : []);
  const anchor = opts.persistedAnchor ?? resolveScheduleAnchor(stated, opts.todayIso);
  const frost = [opts.contextText, opts.deliverableMarkdown ?? "", ...opts.artifacts.filter(a => a.type === "table").map(a => a.content)].map(t => findFrostAnchor(t, opts.todayIso)).find(Boolean);
  const events: InlineCalendarEvent[] = finalizeCalendarEvents(rows
    .map((row) => ({ summary: buildRowSummary(row), startDate: resolveRowStartDate(row, anchor), description: row.description })), frost);
  return { type: "calendar", title: opts.deliverableTitle ?? "Calendar", content: JSON.stringify({ anchor, events }), language: "json" } as Artifact;
}

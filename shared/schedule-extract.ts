/**
 * Schedule extraction — turns conversation artifacts (table/chart/json) and
 * File-Creator generated .md files into schedulable rows, plus the anchor-date
 * math that maps rows onto real calendar dates.
 *
 * Pure and conservative: anything that does not clearly look like a week or an
 * ISO date is skipped. No matches -> empty list -> the export route answers 422.
 */

import fs from "fs";
import path from "path";
import type { Artifact, File, Message } from "./schema";
import { addDaysIso } from "./ics";

export interface ScheduleRow {
  /** 1-based week number (W1 -> 1). */
  weekIndex?: number;
  /** Explicit ISO date "YYYY-MM-DD", used verbatim. */
  date?: string;
  /** Source title: artifact title or generated-file title. */
  title: string;
  description: string;
}

/** Week/date-ish header-key superset (superset of the chart-axis heuristic). */
const WEEK_DATE_KEYS = new Set([
  "week", "wk", "w", "date", "day", "period", "phase", "month", "stage", "time",
]);

/** Hard cap on exported events. */
export const MAX_SCHEDULE_ROWS = 60;

/** Max characters of description accumulated after a .md event line. */
const MD_DESCRIPTION_MAX_CHARS = 200;

/**
 * Parse a week cell such as "W1", "Week 2", "3". Returns undefined for
 * anything without a plausible 1..53 week number.
 */
export function parseWeekCell(cell: string): number | undefined {
  const match = cell.match(/(\d{1,2})/);
  if (!match) return undefined;
  const n = Number(match[1]);
  return n >= 1 && n <= 53 ? n : undefined;
}

/**
 * Strict ISO calendar-date validation. Rejects garbage, out-of-range dates
 * ("2026-02-30") and non-padded forms ("2026-3-1").
 */
export function parseIsoDate(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return undefined;
  }
  return value;
}

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

/** SUMMARY format: "<source title> — Week N" (or the explicit date). */
export function buildRowSummary(row: ScheduleRow): string {
  if (row.weekIndex !== undefined) return `${row.title} — Week ${row.weekIndex}`;
  if (row.date) return `${row.title} — ${row.date}`;
  return row.title;
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

function extractFromTable(artifact: Artifact, rows: ScheduleRow[]): void {
  const table = splitMarkdownTable(artifact.content);
  if (table.length < 2) return;
  const header = table[0];
  const keyIndex = header.findIndex((cell) => WEEK_DATE_KEYS.has(cell.toLowerCase()));
  if (keyIndex === -1) return;
  const title = artifact.title || "Schedule";
  for (const row of table.slice(1)) {
    const cell = row[keyIndex];
    if (!cell) continue;
    const weekIndex = parseWeekCell(cell);
    const date = parseIsoDate(cell);
    if (weekIndex === undefined && date === undefined) continue;
    const description = row.filter((_, i) => i !== keyIndex).join(" — ");
    rows.push({ weekIndex, date, title, description });
  }
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
    const key = Object.keys(entry).find((k) => WEEK_DATE_KEYS.has(k.toLowerCase()));
    if (!key) continue;
    const raw = entry[key];
    const cell = typeof raw === "string" ? raw : String(raw ?? "");
    const weekIndex = parseWeekCell(cell);
    const date = parseIsoDate(cell);
    if (weekIndex === undefined && date === undefined) continue;
    const description = Object.keys(entry)
      .filter((k) => k !== key)
      .map((k) => `${k}: ${String(entry[k] ?? "")}`)
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
    if (current) rows.push(current);
    current = null;
  };

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    const weekMatch = trimmed.match(MD_WEEK_LINE_RE);
    const dateMatch = weekMatch ? null : trimmed.match(ISO_DATE_RE);

    if (weekMatch || dateMatch) {
      flush();
      // Rest of the line (after the week prefix / date) describes the event.
      const rest = (weekMatch
        ? trimmed.slice(weekMatch[0].length)
        : trimmed.replace(ISO_DATE_RE, "")
      )
        .replace(/^[\s—–:*\-]+/, "")
        .trim();
      const descriptionParts: string[] = [];
      if (rest) descriptionParts.push(rest);
      current = {
        weekIndex: weekMatch ? parseWeekCell(weekMatch[1]) : undefined,
        date: dateMatch ? parseIsoDate(dateMatch[0]) : undefined,
        title: sourceTitle,
        description: "",
      };
      current.description = descriptionParts.join(" ");
      continue;
    }

    if (current && trimmed) {
      const sep = current.description ? "\n" : "";
      if (current.description.length + sep.length + trimmed.length <= MD_DESCRIPTION_MAX_CHARS) {
        current.description += sep + trimmed;
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
): ScheduleRow[] {
  const rows: ScheduleRow[] = [];

  for (const message of messages ?? []) {
    for (const artifact of message.artifacts ?? []) {
      if (artifact.type === "table") {
        extractFromTable(artifact, rows);
      } else if (artifact.type === "chart" || artifact.type === "json") {
        try {
          const data = extractObjectArray(JSON.parse(artifact.content));
          extractFromArrayData(data, artifact.title || "Schedule", rows);
        } catch {
          // Not valid JSON — skip silently.
        }
      }
    }
  }

  for (const file of files ?? []) {
    if (!file.uploadedBy.startsWith("Expert:")) continue;
    if (!file.filename.toLowerCase().endsWith(".md")) continue;
    const content = readGeneratedFile(file, readFile);
    if (!content) continue;
    const sourceTitle = file.filename.replace(/\.md$/i, "") || file.filename;
    extractFromMarkdown(content, sourceTitle, rows);
  }

  return rows.slice(0, MAX_SCHEDULE_ROWS);
}

/**
 * Post-processing applied to every expert answer before it is stored:
 *  - citation integrity (only sources retrieved this turn, or URLs already
 *    present earlier in the conversation, may be cited),
 *  - internal metadata lines (STANCE / tool protocol) never reach the farmer,
 *  - overlapping farmer-directed questions are merged instead of repeated.
 */
import { trigramJaccard, normalizeWords } from "./text-similarity";

export type CitableSource = { id: string; url: string };

const URL_RE = /https?:\/\/[^\s)\]>"'`]+/g;

function normalizeUrl(u: string): string {
  return u.replace(/[.,;:!?]+$/, "").replace(/\/$/, "").toLowerCase();
}

export function collectUrls(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.match(URL_RE) ?? []) out.add(normalizeUrl(m));
  return out;
}

/**
 * Keep [S#] markers only for ids retrieved this turn; keep links only to
 * URLs retrieved this turn or already in the conversation. Everything else
 * is removed (marker) or unlinked (markdown link) / dropped (bare URL).
 */
export function enforceCitationIntegrity(
  text: string,
  turnSources: CitableSource[],
  priorConversationText: string[],
): { content: string; removedMarkers: number; removedUrls: number } {
  const validIds = new Set(turnSources.map(s => s.id.toUpperCase()));
  const allowed = collectUrls([...turnSources.map(s => s.url), ...priorConversationText]);
  let removedMarkers = 0;
  let removedUrls = 0;

  // Markdown links first: [label](url)
  let out = text.replace(/\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g, (full, label: string, url: string) => {
    if (allowed.has(normalizeUrl(url))) return full;
    removedUrls++;
    return label;
  });
  // Bare URLs
  out = out.replace(URL_RE, (url) => {
    if (allowed.has(normalizeUrl(url))) return url;
    removedUrls++;
    return "";
  });
  // Source markers: [S3], (S3), [S2, S4], bare S3 / S2/S4
  const keep = (id: string) => validIds.has(id.toUpperCase());
  out = out.replace(/\[(\s*S\d+\s*(?:[,;/]\s*S\d+\s*)*)\]/gi, (_m, inner: string) => {
    const ids = inner.split(/[,;/]/).map(s => s.trim()).filter(Boolean);
    const kept = ids.filter(keep);
    removedMarkers += ids.length - kept.length;
    return kept.length ? `[${kept.join(", ")}]` : "";
  });
  out = out.replace(/\(\s*(S\d+(?:\s*[,;/]\s*S\d+)*)\s*\)/gi, (_m, inner: string) => {
    const ids = inner.split(/[,;/]/).map(s => s.trim());
    const kept = ids.filter(keep);
    removedMarkers += ids.length - kept.length;
    return kept.length ? `(${kept.join(", ")})` : "";
  });
  out = out.replace(/(?<![\w\[(,;/])S\d+(?:\/S\d+)+(?![\w\]])/g, (group) => {
    const ids = group.split("/");
    const kept = ids.filter(keep);
    removedMarkers += ids.length - kept.length;
    return kept.join("/");
  });
  out = out.replace(/(?<![\w\[(,;/])S(\d+)(?![\w\]/])/g, (m) => {
    if (keep(m)) return m;
    removedMarkers++;
    return "";
  });
  // Tidy leftovers like "see  ." or "( )"
  out = out.replace(/\(\s*\)|\[\s*\]/g, "").replace(/[ \t]+([.,;:])/g, "$1").replace(/[ \t]{2,}/g, " ");
  return { content: out, removedMarkers, removedUrls };
}

// ---------- metadata lines ----------

const DECORATION = /^[\s>*_`#~|-]*/;
const META_LINE = /^(STANCE|SEARCH|FETCH|TOOL)\s*:/i;

/** Strip markdown decoration around a line so formatting can't hide metadata. */
export function undecorate(line: string): string {
  return line.replace(DECORATION, "").replace(/[\s*_`~|]+$/, "");
}

export function isMetaLine(line: string): boolean {
  return META_LINE.test(undecorate(line));
}

/** Removes every internal metadata line (any position, any markdown). Returns the last STANCE line seen. */
export function stripMetaLines(text: string): { content: string; stanceLine: string | null } {
  let stanceLine: string | null = null;
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (isMetaLine(line)) {
      const bare = undecorate(line);
      if (/^STANCE\s*:/i.test(bare)) stanceLine = bare.replace(/^STANCE\s*:/i, "STANCE:");
      continue;
    }
    kept.push(line);
  }
  return { content: kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd(), stanceLine };
}

// ---------- overlapping farmer questions ----------

const QUESTION_LINE = /^(?:[-*+]\s*)?(?:\*\*|__)?(?:farmer question|@\[(?:user|farmer)\])(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*(.+)$/i;
const STOP = new Set(["the", "a", "an", "is", "are", "you", "your", "what", "how", "do", "does", "of", "for", "to", "in", "on", "at", "or", "and", "this", "that", "be", "being", "have", "has", "will", "would", "can", "could", "current", "currently", "most", "recent", "any"]);

export function extractQuestionText(line: string): string | null {
  const m = QUESTION_LINE.exec(line.trim());
  return m ? m[1].replace(/[*_]+/g, "").trim() : null;
}

function contentWords(text: string): Set<string> {
  return new Set(normalizeWords(text).filter(w => w.length > 2 && !STOP.has(w)));
}

export function questionsOverlap(a: string, b: string): boolean {
  if (trigramJaccard(a, b) >= 0.5) return true;
  const wa = contentWords(a); const wb = contentWords(b);
  if (!wa.size || !wb.size) return false;
  const shared = Array.from(wa).filter(w => wb.has(w)).length;
  return shared >= 3 && shared / Math.min(wa.size, wb.size) >= 0.6;
}

/**
 * Drops farmer questions already asked by a colleague since the farmer last
 * spoke (and the "Assuming…" line that follows), replacing them with a short
 * pointer to the earlier question.
 */
export function mergeDuplicateFarmerQuestions(
  text: string,
  recent: Array<{ role: string; content: string }>,
): { content: string; merged: number } {
  const prior: Array<{ role: string; q: string }> = [];
  for (const msg of recent) for (const line of msg.content.split("\n")) {
    const q = extractQuestionText(line);
    if (q) prior.push({ role: msg.role, q });
  }
  if (!prior.length) return { content: text, merged: 0 };
  const lines = text.split("\n");
  const out: string[] = [];
  let merged = 0;
  for (let i = 0; i < lines.length; i++) {
    const q = extractQuestionText(lines[i]);
    const match = q ? prior.find(p => questionsOverlap(q, p.q)) : undefined;
    if (!match) { out.push(lines[i]); continue; }
    merged++;
    out.push(`_(I need the same information the ${match.role} asked for above.)_`);
    if (/^\s*(?:[-*+]\s*)?(?:\*\*)?assuming\b/i.test(lines[i + 1] ?? "")) i++;
  }
  return { content: out.join("\n"), merged };
}

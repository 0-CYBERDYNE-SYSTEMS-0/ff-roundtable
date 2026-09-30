/**
 * Mention extraction — the single @-tag parser shared by server and client
 * (SPEC_AUTONOMOUS_COUNCIL G4), so both sides always agree on what a mention
 * is and what it resolves to.
 *
 * Forms recognized (case-insensitive, whitespace-tolerant in both):
 *  - Canonical: `@[Role Name]` — exact role match between the brackets.
 *    `@[soil  scientist]` resolves to the role "Soil Scientist".
 *  - Bare, tolerated: `@Role` / `@Role Name` — the typed words prefix-match
 *    against the roster. "@soil" resolves to "Soil Scientist"; when several
 *    roles share the typed prefix the longest role wins (an exact match
 *    always beats a longer role).
 *
 * Mentions inside code fences ARE matched — stripping fences is not worth the
 * complexity; an expert tagging a colleague inside a code block is rare and
 * harmless (the routed turn still produces a real answer).
 *
 * Pure: no imports, no side effects.
 */

/** Maximal run of role-name-ish characters after a bare "@". */
const BARE_RUN_RE = /^[A-Za-z0-9'’-]*(?:[ \t][A-Za-z0-9'’-]*)*/;

/** Collapse internal whitespace and lowercase for comparison. */
function normalizeRole(role: string): string {
  return role.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Extract the roles mentioned in `content`, resolved against `knownRoles`.
 * Returns canonical role names (spelled as in the roster), in order of first
 * appearance, deduped, and filtered to the roster. The reserved farmer token
 * is always returned as "User", even when that role is not in the roster.
 */
export function extractMentions(content: string, knownRoles: string[]): string[] {
  if (!content) return [];

  // Lookup by normalized name; the first spelling in the roster wins on dupes.
  const roleByNorm = new Map<string, string>();
  for (const role of knownRoles) {
    const norm = normalizeRole(role);
    if (norm && !roleByNorm.has(norm)) roleByNorm.set(norm, role);
  }

  const found: string[] = [];
  const seen = new Set<string>();
  const addRole = (canonical: string): void => {
    if (seen.has(canonical)) return;
    seen.add(canonical);
    found.push(canonical);
  };

  for (let i = 0; i < content.length; i++) {
    if (content[i] !== "@") continue;
    // A mention starts a fresh token — "user@soil" (email) is not one.
    const prev = i > 0 ? content[i - 1] : "";
    if (/[A-Za-z0-9_]/.test(prev)) continue;
    const rest = content.slice(i + 1);

    // Canonical bracketed form: exact match, case/whitespace-insensitive.
    if (rest.startsWith("[")) {
      const close = rest.indexOf("]");
      if (close === -1) continue; // unterminated "@[..."
      const normalized = normalizeRole(rest.slice(1, close));
      if (normalized === "user" || normalized === "farmer") {
        addRole("User");
      } else {
        const canonical = roleByNorm.get(normalized);
        if (canonical) addRole(canonical);
      }
      i += close + 1; // skip past the bracketed tag
      continue;
    }

    // Bare form: prefix-match typed words against the roster, preferring the
    // most words matched, then the exact role, then the longest role.
    const run = rest.match(BARE_RUN_RE)?.[0] ?? "";
    const words = run.trim().split(/\s+/).filter(Boolean);
    for (let k = words.length; k >= 1; k--) {
      const typed = words.slice(0, k).join(" ").toLowerCase();
      const exact = roleByNorm.get(typed);
      if (exact) {
        addRole(exact);
        break;
      }
      let best: string | null = null;
      for (let r = 0; r < knownRoles.length; r++) {
        const norm = normalizeRole(knownRoles[r]);
        if (!norm.startsWith(typed)) continue;
        if (!best || knownRoles[r].length > best.length) best = knownRoles[r];
      }
      if (best) {
        addRole(best);
        break;
      }
    }
  }

  return found;
}

export interface FarmerQuestion {
  question: string;
  assumption: string;
}

function stripOptionalBullet(line: string): string {
  return line.trim().replace(/^[-*+]\s+/, "").trim();
}

/**
 * Extract non-blocking farmer questions from expert response lines.
 *
 * Each pair must have the form `@[User] <question ending ?>` followed
 * immediately by `Assuming <assumption>`. `@[Farmer]` is an accepted alias;
 * Markdown bullet markers are optional. Malformed pairs are skipped, and
 * exact duplicate extracted pairs are returned only once in source order.
 */
export function extractFarmerQuestions(content: string): FarmerQuestion[] {
  if (!content) return [];

  const lines = content.split(/\r?\n/);
  const questions: FarmerQuestion[] = [];
  const seenPairs = new Set<string>();

  for (let i = 0; i < lines.length - 1; i++) {
    const questionLine = stripOptionalBullet(lines[i]);
    const questionMatch = questionLine.match(/^@\[\s*(?:user|farmer)\s*\]\s+(.+?)\s*$/i);
    if (!questionMatch) continue;

    const question = questionMatch[1].trim();
    if (!question || question === "?" || !question.endsWith("?")) continue;

    const assumptionLine = stripOptionalBullet(lines[i + 1]);
    const assumptionMatch = assumptionLine.match(/^Assuming\s+(.+?)\s*$/);
    if (!assumptionMatch) continue;

    const assumption = assumptionMatch[1].trim();
    if (!assumption) continue;

    const pairKey = JSON.stringify([question, assumption]);
    if (!seenPairs.has(pairKey)) {
      seenPairs.add(pairKey);
      questions.push({ question, assumption });
    }
    i++; // The immediately following line belongs to this question pair.
  }

  return questions;
}

/**
 * Dependency-free markdown → plaintext conversion for export paths (e.g. .ics
 * DESCRIPTION) where raw markdown would surface as literal glyphs ("**", "#",
 * "](") in apps that do not render markdown. The chat UI renders markdown
 * itself — never feed artifact content through this; export paths only.
 */

/**
 * Strip markdown decoration and return plain text:
 * - heading hashes ("## Plan" -> "Plan")
 * - bold/italic/strikethrough markers ("**b**", "*i*", "_e_", "~~s~~")
 * - inline-code backticks ("`x`" -> "x")
 * - links "[text](url)" -> "text", images "![alt](url)" -> "alt"
 * - table pipes -> " | "
 * - runs of 3+ newlines collapsed to 2
 * Pure: no dependencies, no side effects, safe on empty input.
 */
export function stripMarkdownToText(md: string): string {
  if (!md) return "";
  let text = md;

  // Images first: ![alt](url) would otherwise be eaten by the link rule.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Links: [text](url) -> text
  text = text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1");
  // Inline code: keep the content, drop the backticks.
  text = text.replace(/`([^`]*)`/g, "$1");
  // ATX headings: leading "# ".."###### " on any line.
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  // Emphasis — longest markers first so *** and ** unwrap cleanly.
  // ([\s\S] instead of dotAll: markers may wrap lines.)
  text = text.replace(/(\*\*\*|___)([\s\S]*?)\1/g, "$2");
  text = text.replace(/(\*\*|__)([\s\S]*?)\1/g, "$2");
  text = text.replace(/~~([\s\S]*?)~~/g, "$1");
  // Single-underscore emphasis only outside words, so snake_case survives.
  // (Manual lookbehind: kept ES5-regex compatible for `tsc`.)
  text = text.replace(/_([^_\n]+)_(?!\w)/g, (full: string, inner: string, offset: number, whole: string) => {
    const prev = offset > 0 ? whole[offset - 1] : "";
    return prev && /[\w\\]/.test(prev) ? full : inner;
  });
  text = text.replace(/\*([^*\n]+)\*/g, "$1");
  // Table pipes become readable separators.
  text = text.replace(/[ \t]*\|[ \t]*/g, " | ");
  // Collapse artifacts left behind by removed markers, then blank-line runs.
  text = text.replace(/[ \t]{2,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

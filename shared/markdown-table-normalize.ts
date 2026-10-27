/**
 * Normalizes a markdown table so every row has the header's column count.
 * Models often append citation markers as an extra cell ("| … | [S1] |");
 * those are merged into the previous cell. Other extra cells are merged into
 * the last column; short rows are padded.
 */
const CITATION_CELL = /^(\s*\[(?:S|R|\d)[\w-]*\]\s*,?\s*)+$/i;

function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map(c => c.trim());
}

export function normalizeMarkdownTable(table: string): string {
  const lines = table.split("\n");
  const sepIdx = lines.findIndex(l => /^\s*\|?[\s:-]+(\|[\s:-]+)+\|?\s*$/.test(l));
  if (sepIdx < 1) return table;
  const width = splitRow(lines[sepIdx - 1]).length;
  return lines.map((line, i) => {
    if (i === sepIdx || !line.trim().startsWith("|")) return line;
    let cells = splitRow(line);
    if (cells.length === width) return line;
    while (cells.length > width) {
      const last = cells.pop()!;
      const joined = CITATION_CELL.test(last) || !last ? `${cells[cells.length - 1]} ${last}`.trim() : `${cells[cells.length - 1]}; ${last}`;
      cells[cells.length - 1] = joined;
    }
    while (cells.length < width) cells.push("");
    return `| ${cells.join(" | ")} |`;
  }).join("\n");
}

/** Normalizes every markdown table block inside free text. */
export function normalizeMarkdownTablesInText(text: string): string {
  if (!text.includes("|")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].trim().startsWith("|")) {
      let j = i;
      while (j < lines.length && lines[j].trim().startsWith("|")) j++;
      out.push(normalizeMarkdownTable(lines.slice(i, j).join("\n")));
      i = j;
    } else out.push(lines[i++]);
  }
  return out.join("\n");
}

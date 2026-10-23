import type { MessageStance } from "@shared/schema";

/** Validate the structured Markdown requested by the closing prompt. */
export function hasFreeVerdictTable(content: string, ledger: Record<string, MessageStance | null>): boolean {
  const lines = content.split(/\r?\n/);
  const header = lines.findIndex(line => /^\s*\|\s*Expert\s*\|\s*Stance\s*\|\s*Confidence\s*\|\s*Position\s*\|/i.test(line));
  if (!/^##\s+Verdict\b/im.test(content) || header < 0 ||
      !/^\s*\|(?:\s*:?-+:?\s*\|){4}\s*$/.test(lines[header + 1] ?? "")) return false;
  const rows: string[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.trim().startsWith("|")) break;
    rows.push(line);
  }
  return rows.length > 0 && Object.keys(ledger).every(role =>
    rows.some(row => row.split("|")[1]?.trim() === role));
}

/** Render only recorded evidence, never invent an expert's missing stance. */
export function ensureFreeVerdictTable(content: string, ledger: Record<string, MessageStance | null>): string {
  if (hasFreeVerdictTable(content, ledger)) return content;
  const cell = (value: unknown) => String(value ?? "none recorded").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  const rows = Object.entries(ledger).map(([role, stance]) =>
    `| ${cell(role)} | ${cell(stance?.stance)} | ${cell(stance?.confidence)} | ${cell(stance?.position)} |`);
  return `${content}\n\n## Verdict — recorded expert stances\n\n| Expert | Stance | Confidence | Position |\n| --- | --- | --- | --- |\n${rows.join("\n")}`;
}

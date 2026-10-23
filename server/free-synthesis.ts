import type { MessageStance } from "@shared/schema";

/** Render only recorded evidence, never invent an expert's missing stance. */
export function ensureFreeVerdictTable(content: string, ledger: Record<string, MessageStance | null>): string {
  if (/^\s*\|\s*Expert\s*\|\s*Stance\s*\|\s*Confidence\s*\|\s*Position\s*\|/im.test(content)) return content;
  const cell = (value: unknown) => String(value ?? "none recorded").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  const rows = Object.entries(ledger).map(([role, stance]) =>
    `| ${cell(role)} | ${cell(stance?.stance)} | ${cell(stance?.confidence)} | ${cell(stance?.position)} |`);
  return `${content}\n\n## Verdict — recorded expert stances\n\n| Expert | Stance | Confidence | Position |\n| --- | --- | --- | --- |\n${rows.join("\n")}`;
}

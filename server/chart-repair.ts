// Repair + fallback for model-written chart JSON (FF_PREMIUM_CHARTS path).
// Order: strict parse → fence/outer-brace extraction → lenient JSON fixes → truncation close.
// If the spec still will not compile, rebuild a plain themed chart from the rows.

import { parseChartNumericValue, findRangeGroups } from "@shared/chart-artifact";

/** Close unbalanced braces/brackets of a truncated JSON document; null if not fixable. */
export function closeTruncatedJson(text: string): string | null {
  const closers: string[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) { if (c === "\\") i++; else if (c === '"') inString = false; }
    else if (c === '"') inString = true;
    else if (c === "{") closers.push("}");
    else if (c === "[") closers.push("]");
    else if (c === "}" || c === "]") { if (closers.pop() !== c) return null; }
  }
  if (inString) return null;
  return text.replace(/,\s*$/, "") + closers.reverse().join("");
}

function stripComments(text: string): string {
  let out = "", inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) { out += c; if (c === "\\") { out += text[++i] ?? ""; } else if (c === '"') inString = false; continue; }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i + 2); if (i < 0) break; i++; continue; }
    out += c;
  }
  return out;
}

/** Curly quotes → straight; single-quoted strings → double-quoted (outside double-quoted strings). */
function normalizeQuotes(text: string): string {
  const t = text.replace(/[\u201C\u201D\u201E]/g, '"').replace(/[\u2018\u2019]/g, "'");
  let out = "", inDouble = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inDouble) { out += c; if (c === "\\") out += t[++i] ?? ""; else if (c === '"') inDouble = false; continue; }
    if (c === '"') { inDouble = true; out += c; continue; }
    if (c === "'" && /[\s{\[,:]/.test(t[i - 1] ?? " ")) {
      const end = t.indexOf("'", i + 1);
      if (end > i && !t.slice(i + 1, end).includes("\n")) { out += JSON.stringify(t.slice(i + 1, end)); i = end; continue; }
    }
    out += c;
  }
  return out;
}

/** Left-to-right with * and / precedence; only digits and + - * / reach here. */
function evalArithmetic(expr: string): number {
  const tokens = expr.replace(/\s+/g, "").match(/^-?\d+(?:\.\d+)?|[-+*/]|\d+(?:\.\d+)?/g) ?? [];
  const terms: number[] = []; let op = "+"; let i = 0;
  const num = () => Number(tokens[i++]);
  let cur = num();
  while (i < tokens.length) {
    const o = tokens[i++]; const n = num();
    if (o === "*") cur *= n; else if (o === "/") cur /= n;
    else { terms.push(op === "-" ? -cur : cur); op = o; cur = n; }
  }
  terms.push(op === "-" ? -cur : cur);
  const total = terms.reduce((a, b) => a + b, 0);
  return Number.isFinite(total) ? Math.round(total * 1e6) / 1e6 : 0;
}

/** Lenient fixes for typical cheap-model slips: unquoted keys, trailing commas, comments, NaN. */
export function lenientJson(text: string): string {
  return stripComments(normalizeQuotes(text))
    // Thousands separators in bare numbers: "hours": 1,800 → 1800 (only after a key).
    .replace(/(:\s*-?)(\d{1,3}(?:,\d{3})+)(?=\s*[,}\]\n])/g, (_m, p, n) => p + n.replace(/,/g, ""))
    // Simple arithmetic models leave in values: "net": 6500 - 6300 → 200.
    .replace(/(:\s*)(-?\d+(?:\.\d+)?(?:\s*[-+*/]\s*\d+(?:\.\d+)?)+)(?=\s*[,}\]])/g, (_m, p, expr) => p + String(evalArithmetic(expr)))
    // Missing commas between array items / properties.
    .replace(/}(\s*){/g, "},$1{")
    .replace(/](\s*)\[/g, "],$1[")
    .replace(/"(\s*\n\s*)"/g, '",$1"')
    .replace(/([{,]\s*)"?([A-Za-z_$][\w$]*)"?(\s*):/g, '$1"$2"$3:')
    .replace(/:\s*(NaN|undefined|Infinity|-Infinity)\b/g, ": null")
    .replace(/,(\s*[}\]])/g, "$1");
}

export type RepairResult = { value: unknown; repaired: false | "extracted" | "lenient" | "truncated" };

export function parseChartJsonWithRepair(raw: string): RepairResult {
  try { return { value: JSON.parse(raw), repaired: false }; } catch { /* continue */ }
  const fenced = raw.replace(/^\s*```[a-z-]*\s*\n?/i, "").replace(/\n?```\s*$/, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  const body = start >= 0 ? fenced.slice(start, end > start ? end + 1 : undefined) : fenced;
  try { return { value: JSON.parse(body), repaired: "extracted" }; } catch { /* continue */ }
  const lenient = lenientJson(body);
  try { return { value: JSON.parse(lenient), repaired: "lenient" }; } catch { /* continue */ }
  const fromStart = lenientJson(start >= 0 ? fenced.slice(start) : fenced);
  const closed = closeTruncatedJson(fromStart);
  if (closed) { try { return { value: JSON.parse(closed), repaired: "truncated" }; } catch { /* fall through */ } }
  throw new Error("unrepairable chart JSON");
}

const DATEISH = /^\d{4}-\d{2}(-\d{2})?/;

/** Deterministic plain chart from envelope rows when the model's spec cannot be used. */
export function fallbackSpecFromRows(rows: Record<string, unknown>[]): Record<string, unknown> | null {
  if (!rows.length) return null;
  const fields = Object.keys(rows[0]);
  const numeric = fields.filter(f => rows.every(r => r[f] === null || parseChartNumericValue(r[f]) !== undefined));
  const nominal = fields.filter(f => !numeric.includes(f));
  const measures = numeric.filter(f => !/^(year|week|day|month|id)$/i.test(f));
  const group = findRangeGroups(rows as never, new Set(measures))[0];
  const y = group?.mid ?? group?.low ?? measures[0] ?? numeric[0];
  if (!y) return null;
  const x = nominal[0] ?? numeric.find(f => f !== y);
  if (!x) return null;
  const temporal = rows.every(r => typeof r[x] === "string" && DATEISH.test(r[x] as string));
  const series = nominal.find(f => f !== x);
  const xEnc = temporal ? { field: x, type: "temporal", title: null } : { field: x, type: numeric.includes(x) ? "ordinal" : "nominal", sort: null, title: null };
  const encoding: Record<string, unknown> = { x: xEnc, y: { field: y, type: "quantitative", title: y }, tooltip: fields.map(field => ({ field })) };
  if (series) encoding.color = { field: series, type: "nominal", title: null };
  const timeLike = temporal || /month|week|year|date|day/i.test(x);
  return timeLike ? { mark: { type: "line", point: true, interpolate: "monotone" }, encoding } : { mark: { type: "bar", cornerRadiusEnd: 3 }, encoding };
}

/** Models often put data.values inside layers. Hoist inline rows into the envelope and strip nested data keys (urls are dropped, never fetched). */
export function hoistNestedData(chart: { data?: unknown; spec?: unknown }): boolean {
  const found: unknown[][] = [];
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "data" || k === "datasets") { const vals = (v as any)?.values; if (Array.isArray(vals)) found.push(vals); continue; }
      out[k] = strip(v);
    }
    return out;
  };
  const spec = strip(chart.spec);
  if (!found.length) return false;
  chart.spec = spec;
  if (!Array.isArray(chart.data) || chart.data.length === 0) {
    const distinct = Array.from(new Set(found.map(v => JSON.stringify(v)))).map(s => JSON.parse(s) as unknown[]);
    chart.data = distinct.flat().slice(0, 5000);
  }
  return true;
}

/**
 * Robust JSON extraction for model output. Free models often wrap JSON in
 * code fences, add prose around it, leave trailing commas or stop before the
 * closing brackets. Returns null when nothing usable can be recovered.
 */
export function parseModelJson<T = unknown>(raw: unknown): T | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json|JSON)?\s*([\s\S]*?)(?:```|$)/);
  if (fenced && fenced[1].trim()) text = fenced[1].trim();
  const tryParse = (candidate: string): T | null => {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text);
  if (direct !== null) return direct;
  const start = text.search(/[\[{]/);
  if (start < 0) return null;
  const body = text.slice(start);
  // Walk to the matching close (string-aware); remember unclosed openers.
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      stack.pop();
      if (stack.length === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const noTrailingCommas = (s: string) => s.replace(/,\s*([}\]])/g, "$1");
  if (end > 0) {
    const slice = body.slice(0, end);
    return tryParse(slice) ?? tryParse(noTrailingCommas(slice));
  }
  // Partial JSON: close the open string and brackets, dropping a dangling key/comma.
  let partial = body;
  if (inString) partial += '"';
  partial = partial.replace(/,\s*$/, "").replace(/,\s*"[^"]*"\s*:?\s*$/, "").replace(/:\s*$/, ": null");
  const closed = noTrailingCommas(partial + stack.reverse().join(""));
  return tryParse(closed);
}

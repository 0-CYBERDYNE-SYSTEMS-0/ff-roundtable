/** Display hints only: never replace the original request sent to the experts. */
export function requestPresentation(content: string): { summary: string } | null {
  const codeFence = /```|~~~/;
  const structuredData = /(?:^|\s)(?:\{\s*"[^"\n]+"\s*:|\[\s*(?:\{|"|-?\d))/;
  const implementationRules = [
    /\b(?:chart|code) fence\b/i,
    /\b(?:json|vega-lite|rfc\s?5545)\b/i,
    /\b(?:schema|envelope|datasets|usermeta|dtstart|dtend|filetype)\b/i,
    /\b(?:spec|filename|content)\s*:/i,
  ].filter(pattern => pattern.test(content)).length;
  if (!codeFence.test(content) && !structuredData.test(content) && implementationRules < 2) return null;

  const plainStart = content.replace(/^(?:\s*@\[[^\]]+\]\s*)+/, "").trim();
  // Use the author's own words, stopping before code, data, or a long sentence.
  const firstSentence = plainStart.split(/(?<=[.!?])\s+|\n/)[0];
  const technicalSentence = /```|[{}]|\b(?:json|schema|envelope|rfc\s?5545|dtstart|dtend|usermeta|filetype)\b/i;
  const summary = firstSentence && !technicalSentence.test(firstSentence) && firstSentence.length <= 200
    ? firstSentence
    : "Request with technical details.";
  return { summary };
}

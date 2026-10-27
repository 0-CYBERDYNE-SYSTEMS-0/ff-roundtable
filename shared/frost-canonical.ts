import { isAuthoritativeClimateHost } from "./chart-artifact";

export type FrostSource = { title?: string; url: string };
export type CanonicalFrost = { location: string; lastFrost: string; threshold?: string; sourceUrl: string; sourceTitle: string };

/** Extract one cited, authoritative frost value without making network calls. */
export function extractCanonicalFrost(text: string, sources: FrostSource[] = []): CanonicalFrost | null {
  const cited = (text.match(/https?:\/\/[^\s)]+/g) ?? []).map(url => url.replace(/[.,]+$/, "")).find(isAuthoritativeClimateHost);
  if (!cited) return null;
  const date = text.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}\b/i)?.[0];
  if (!date) return null;
  const locationMatch = text.match(/(?:last (?:spring )?frost|last frost)\s+(?:for|in|near)\s+([A-Z][A-Za-z .'-]+?)(?=\s*(?:is|was|falls|:|[,.]|\b(?:around|on)\b))/i)
    ?? text.match(/([A-Z][A-Za-z .'-]+?)['’]s\s+last (?:spring )?frost/i);
  const location = locationMatch?.[1]?.trim().replace(/[.,]$/, "") ?? "local area";
  const threshold = text.match(/\b(\d{2})\s*(?:°\s*)?F\b/i)?.[1];
  const source = sources.find(s => s.url === cited);
  return { location, lastFrost: date, ...(threshold ? { threshold: `${threshold}°F` } : {}), sourceUrl: cited, sourceTitle: source?.title?.trim() || "Authoritative climate source" };
}

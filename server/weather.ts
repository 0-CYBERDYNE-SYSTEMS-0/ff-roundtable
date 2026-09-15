import { storage } from "./storage";

const OWM_BASE = "https://api.openweathermap.org/data/3.0/onecall";
const FRESH_TTL_MS = 30 * 60 * 1000; // 30 minutes — how long a successful fetch is served as-is
const STALE_MAX_MS = 24 * 60 * 60 * 1000; // 24 hours — oldest cache entry served on fetch failure
const AUTH_NEGATIVE_TTL_MS = 30 * 60 * 1000; // 30 min — an unauthorized key doesn't heal mid-process
const TRANSIENT_NEGATIVE_TTL_MS = 5 * 60 * 1000; // 5 min — retry transient failures after a cooldown

export interface WeatherData {
  current: {
    temp: number;
    feels_like: number;
    humidity: number;
    wind_speed: number;
    wind_deg: number;
    weather: Array<{ main: string; description: string }>;
    rain?: { "1h": number };
    snow?: { "1h": number };
  };
  daily: Array<{
    dt: number;
    temp: { min: number; max: number; day: number };
    humidity: number;
    wind_speed: number;
    weather: Array<{ main: string; description: string }>;
    pop: number; // probability of precipitation
    rain?: number;
  }>;
}

export type WeatherFailureReason = "missing_key" | "auth" | "transient";

export type WeatherResult =
  | { ok: true; data: WeatherData }
  | { ok: false; reason: WeatherFailureReason; message: string };

// ─── Pure helpers (unit-testable) ────────────────────────────────────────────

export function classifyOwmStatus(status: number): WeatherFailureReason {
  return status === 401 || status === 403 ? "auth" : "transient";
}

// End-user-safe messages. Ops hints ("check OWM_API_KEY / One Call 3.0 access")
// belong in server logs and DEV_MODE responses only — never in these strings.
export function userSafeMessage(reason: WeatherFailureReason): string {
  switch (reason) {
    case "auth":
    case "missing_key":
      return "Weather is not configured for this server.";
    case "transient":
      return "Weather data is temporarily unavailable.";
  }
}

// OWM API keys are 32 hex characters.
export function isValidOwmKeyShape(key: string | undefined | null): boolean {
  return typeof key === "string" && /^[0-9a-f]{32}$/i.test(key);
}

export function describeOwmKey(key: string | undefined | null): {
  present: boolean;
  looksMalformed: boolean;
} {
  return { present: !!key, looksMalformed: !!key && !isValidOwmKeyShape(key) };
}

export function isFresh(fetchedAt: Date | string, now: number = Date.now()): boolean {
  const t = new Date(fetchedAt).getTime();
  return Number.isFinite(t) && now - t < FRESH_TTL_MS;
}

export function isStaleUsable(fetchedAt: Date | string, now: number = Date.now()): boolean {
  const t = new Date(fetchedAt).getTime();
  return Number.isFinite(t) && now - t <= STALE_MAX_MS;
}

function negativeTtlMs(reason: WeatherFailureReason): number {
  return reason === "auth" ? AUTH_NEGATIVE_TTL_MS : TRANSIENT_NEGATIVE_TTL_MS;
}

// ─── Negative cache ──────────────────────────────────────────────────────────

const negativeCache = new Map<string, { reason: WeatherFailureReason; until: number }>();
let missingKeyLogged = false;

function negativeCacheKey(lat: string, lng: string): string {
  return `${lat}:${lng}`;
}

/** Test/ops helper: clear all negative-cache cooldowns. */
export function resetWeatherNegativeCache(): void {
  negativeCache.clear();
}

// ─── Formatting ──────────────────────────────────────────────────────────────

export function formatWeatherData(weather: WeatherData): string {
  const c = weather.current;
  const today = weather.daily[0];
  const tomorrow = weather.daily[1];

  const windDir = (deg: number) => {
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return dirs[Math.round(deg / 45) % 8];
  };

  let forecast = `Current conditions at the farm: ${Math.round(c.temp)}°F (feels like ${Math.round(c.feels_like)}°F), ${c.weather[0]?.description || "clear"}, humidity ${c.humidity}%, wind ${Math.round(c.wind_speed)}mph ${windDir(c.wind_deg)}.`;

  if (c.rain) forecast += ` Currently raining (${c.rain["1h"]}mm/hr).`;
  if (c.snow) forecast += ` Currently snowing.`;

  forecast += `\nToday: ${Math.round(today.temp.min)}°F to ${Math.round(today.temp.max)}°F, ${today.weather[0]?.description || "clear"}, ${Math.round(today.pop * 100)}% chance of precipitation.`;

  if (tomorrow) {
    forecast += `\nTomorrow: ${Math.round(tomorrow.temp.min)}°F to ${Math.round(tomorrow.temp.max)}°F, ${tomorrow.weather[0]?.description || "clear"}, ${Math.round(tomorrow.pop * 100)}% chance of precipitation.`;
  }

  return forecast;
}

// Accepts the full WeatherResult union so call sites that haven't been migrated
// to `if (!result.ok)` yet still type-check; a failure formats to an empty
// string ("unavailable → no weather context", per SPEC F1 design item 5).
export function formatWeatherForPrompt(input: WeatherData | WeatherResult): string {
  if (input && typeof input === "object" && "ok" in input) {
    return input.ok ? formatWeatherData(input.data) : "";
  }
  return formatWeatherData(input);
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

export async function getWeather(lat: string, lng: string): Promise<WeatherResult> {
  const apiKey = process.env.OWM_API_KEY;
  if (!apiKey) {
    // Zero network calls without a key. Log once per process, not per call.
    if (!missingKeyLogged) {
      missingKeyLogged = true;
      console.warn(
        "[Weather] OWM_API_KEY is not set — weather is disabled. " +
          "Set OWM_API_KEY (enabled for One Call 3.0) to enable weather features.",
      );
    }
    return { ok: false, reason: "missing_key", message: userSafeMessage("missing_key") };
  }

  const cacheKey = negativeCacheKey(lat, lng);
  const cooldown = negativeCache.get(cacheKey);
  if (cooldown && Date.now() < cooldown.until) {
    // Short-circuit before any network call; the loud log already happened
    // once when this cooldown entry was created.
    return await failureResult(lat, lng, cooldown.reason);
  }

  const cached = await storage.getCachedWeather(lat, lng);
  if (cached && cached.fetchedAt && isFresh(cached.fetchedAt)) {
    return { ok: true, data: cached.data as WeatherData };
  }

  // Fetch from OpenWeatherMap
  let response: Response;
  try {
    const url = `${OWM_BASE}?lat=${lat}&lon=${lng}&appid=${apiKey}&units=imperial&exclude=minutely,hourly,alerts`;
    response = await fetch(url);
  } catch (err) {
    console.error("[Weather] Fetch error:", err);
    return await failureResult(lat, lng, "transient");
  }

  if (!response.ok) {
    const reason = classifyOwmStatus(response.status);
    const errText = await response.text().catch(() => "");
    console.error(
      `[Weather] OWM API error ${response.status} for ${lat},${lng} — entering ` +
        `${Math.round(negativeTtlMs(reason) / 60000)}min cooldown. ` +
        `(Ops: if 401/403, verify the key is enabled for One Call 3.0.) Response: ${errText.slice(0, 200)}`,
    );
    return await failureResult(lat, lng, reason);
  }

  try {
    const data: WeatherData = await response.json();
    negativeCache.delete(cacheKey);
    await storage.cacheWeather(lat, lng, data);
    return { ok: true, data };
  } catch (err) {
    console.error("[Weather] Failed to parse OWM response:", err);
    return await failureResult(lat, lng, "transient");
  }
}

/**
 * Build a typed failure: log loudly once per cooldown window, arm the negative
 * cache, then fall back to any cache entry ≤ 24 h old (stale-while-revalidate).
 */
async function failureResult(lat: string, lng: string, reason: WeatherFailureReason): Promise<WeatherResult> {
  const cacheKey = negativeCacheKey(lat, lng);
  const existing = negativeCache.get(cacheKey);
  const until = Date.now() + negativeTtlMs(reason);
  if (!existing || existing.reason !== reason || existing.until <= Date.now()) {
    negativeCache.set(cacheKey, { reason, until });
  }

  // Stale-while-revalidate: serve any cache entry ≤ 24 h old instead of failing.
  try {
    const stale = await storage.getCachedWeather(lat, lng);
    if (stale && stale.fetchedAt && isStaleUsable(stale.fetchedAt)) {
      console.warn(
        `[Weather] Serving stale cache for ${lat},${lng} (fetched ${new Date(stale.fetchedAt).toISOString()}) — OWM unavailable (${reason}).`,
      );
      return { ok: true, data: stale.data as WeatherData };
    }
  } catch (err) {
    console.error("[Weather] Stale cache lookup failed:", err);
  }

  return { ok: false, reason, message: userSafeMessage(reason) };
}

// Aliases for backward compatibility with ai.ts
export const getWeatherForFarm = getWeather;
export const formatWeatherContext = formatWeatherForPrompt;

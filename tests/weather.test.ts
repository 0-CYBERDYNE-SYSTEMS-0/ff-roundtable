/**
 * F1 — Weather resilience tests (SPEC_DOGFOOD_GAP_REMEDIATION.md)
 *
 * Mocks global fetch. Uses MemStorage (vitest.config.ts sets DATABASE_URL="").
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getWeather,
  resetWeatherNegativeCache,
  classifyOwmStatus,
  userSafeMessage,
  describeOwmKey,
  isValidOwmKeyShape,
  isFresh,
  isStaleUsable,
  formatWeatherForPrompt,
  type WeatherData,
} from "../server/weather";
import { storage } from "../server/storage";

const LAT = "38.5816";
const LNG = "-121.4944";
const CACHE_KEY = `${LAT},${LNG}`; // MemStorage key format

const weatherFixture: WeatherData = {
  current: {
    temp: 72, feels_like: 70, humidity: 55, wind_speed: 8, wind_deg: 180,
    weather: [{ main: "Clear", description: "clear sky" }],
  },
  daily: [
    { dt: 1717027200, temp: { min: 60, max: 78, day: 72 }, humidity: 55,
      wind_speed: 8, weather: [{ main: "Clear", description: "clear sky" }], pop: 0.1 },
  ],
};

function httpResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn();

let originalKey: string | undefined;

beforeEach(() => {
  originalKey = process.env.OWM_API_KEY;
  process.env.OWM_API_KEY = "a".repeat(32);
  resetWeatherNegativeCache();
  (storage as unknown as { weatherCache: Map<string, unknown> }).weatherCache.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.OWM_API_KEY;
  } else {
    process.env.OWM_API_KEY = originalKey;
  }
  vi.unstubAllGlobals();
});

// Backdate the MemStorage weather-cache entry so it is no longer fresh (>30 min).
function backdateCache(hoursAgo: number): void {
  const entry = (storage as any).weatherCache?.get(CACHE_KEY);
  if (!entry) throw new Error(`no weather cache entry for ${CACHE_KEY}`);
  entry.fetchedAt = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
}

describe("getWeather — typed results", () => {
  it("missing_key with zero fetches when OWM_API_KEY is unset", async () => {
    delete process.env.OWM_API_KEY;

    const result = await getWeather(LAT, LNG);

    expect(result).toEqual({
      ok: false,
      reason: "missing_key",
      message: "Weather is not configured for this server.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401 → auth, and negative-cache short-circuits (fetch called exactly once)", async () => {
    fetchMock.mockResolvedValue(httpResponse(401, { message: "Invalid API key." }));

    const first = await getWeather(LAT, LNG);
    const second = await getWeather(LAT, LNG);

    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.reason).toBe("auth");
      expect(first.message).toBe("Weather is not configured for this server.");
    }
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("user-safe messages never leak ops hints", async () => {
    for (const reason of ["auth", "missing_key", "transient"] as const) {
      const msg = userSafeMessage(reason);
      expect(msg).not.toMatch(/owm|api key|appid|3\.0|env/i);
    }
  });

  it("500 → transient", async () => {
    fetchMock.mockResolvedValue(httpResponse(500, { message: "boom" }));

    const result = await getWeather(LAT, LNG);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("transient");
      expect(result.message).toBe("Weather data is temporarily unavailable.");
    }
  });

  it("network error → transient", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));

    const result = await getWeather(LAT, LNG);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("transient");
  });

  it("success returns data, caches it, and a second call does not refetch", async () => {
    fetchMock.mockResolvedValue(httpResponse(200, weatherFixture));

    const first = await getWeather(LAT, LNG);
    const second = await getWeather(LAT, LNG);

    expect(first).toEqual({ ok: true, data: weatherFixture });
    expect(second).toEqual({ ok: true, data: weatherFixture });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getWeather — stale-while-revalidate", () => {
  it("serves cache entry < 24h old on transient failure", async () => {
    fetchMock.mockResolvedValueOnce(httpResponse(200, weatherFixture));
    await getWeather(LAT, LNG); // prime the cache
    backdateCache(2); // 2h old: not fresh (>30 min), but stale-usable (<24h)

    fetchMock.mockResolvedValueOnce(httpResponse(500));
    const result = await getWeather(LAT, LNG);

    expect(result).toEqual({ ok: true, data: weatherFixture });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not serve cache entries older than 24h", async () => {
    fetchMock.mockResolvedValueOnce(httpResponse(200, weatherFixture));
    await getWeather(LAT, LNG);
    backdateCache(25); // beyond the 24h stale horizon

    fetchMock.mockResolvedValueOnce(httpResponse(500));
    const result = await getWeather(LAT, LNG);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("transient");
  });

  it("serves stale data on auth failure too (negative-cache short-circuit path)", async () => {
    fetchMock.mockResolvedValueOnce(httpResponse(200, weatherFixture));
    await getWeather(LAT, LNG);
    backdateCache(1);

    fetchMock.mockResolvedValueOnce(httpResponse(401));
    await getWeather(LAT, LNG); // arms the 30-min auth cooldown

    const third = await getWeather(LAT, LNG); // short-circuits before fetch
    expect(third).toEqual({ ok: true, data: weatherFixture });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("pure helpers", () => {
  it("classifyOwmStatus maps 401/403 → auth, everything else → transient", () => {
    expect(classifyOwmStatus(401)).toBe("auth");
    expect(classifyOwmStatus(403)).toBe("auth");
    expect(classifyOwmStatus(429)).toBe("transient");
    expect(classifyOwmStatus(500)).toBe("transient");
    expect(classifyOwmStatus(404)).toBe("transient");
  });

  it("isValidOwmKeyShape / describeOwmKey detect malformed keys", () => {
    expect(isValidOwmKeyShape("a".repeat(32))).toBe(true);
    expect(isValidOwmKeyShape("A".repeat(32))).toBe(true);
    expect(isValidOwmKeyShape("short-key")).toBe(false);
    expect(isValidOwmKeyShape("z".repeat(32))).toBe(false); // non-hex
    expect(isValidOwmKeyShape(undefined)).toBe(false);

    expect(describeOwmKey(undefined)).toEqual({ present: false, looksMalformed: false });
    expect(describeOwmKey("abc")).toEqual({ present: true, looksMalformed: true });
    expect(describeOwmKey("a".repeat(32))).toEqual({ present: true, looksMalformed: false });
  });

  it("isFresh (30 min) and isStaleUsable (24 h) boundaries", () => {
    const now = Date.now();
    expect(isFresh(new Date(now - 29 * 60 * 1000), now)).toBe(true);
    expect(isFresh(new Date(now - 31 * 60 * 1000), now)).toBe(false);
    expect(isStaleUsable(new Date(now - 23 * 60 * 60 * 1000), now)).toBe(true);
    expect(isStaleUsable(new Date(now - 25 * 60 * 60 * 1000), now)).toBe(false);
    expect(isStaleUsable(new Date("not-a-date"), now)).toBe(false);
  });

  it("formatWeatherForPrompt formats data and maps failure results to empty string", () => {
    const text = formatWeatherForPrompt(weatherFixture);
    expect(text).toContain("72°F");
    expect(text).toContain("clear sky");

    expect(formatWeatherForPrompt({
      ok: false, reason: "auth", message: "Weather is not configured for this server.",
    })).toBe("");
  });
});

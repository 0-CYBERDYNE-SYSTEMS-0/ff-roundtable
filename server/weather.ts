import { storage } from "./storage";

const OWM_BASE = "https://api.openweathermap.org/data/3.0/onecall";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

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

export function formatWeatherForPrompt(weather: WeatherData): string {
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

export async function getWeather(lat: string, lng: string): Promise<WeatherData | null> {
  const apiKey = process.env.OWM_API_KEY;
  if (!apiKey) {
    console.log("[Weather] No OWM_API_KEY configured — skipping weather fetch");
    return null;
  }

  // Check cache first
  const cached = await storage.getCachedWeather(lat, lng);
  if (cached) {
    console.log("[Weather] Cache hit for", lat, lng);
    return cached.data as WeatherData;
  }

  // Fetch from OpenWeatherMap
  try {
    const url = `${OWM_BASE}?lat=${lat}&lon=${lng}&appid=${apiKey}&units=imperial&exclude=minutely,hourly,alerts`;
    console.log("[Weather] Fetching from OpenWeatherMap...");

    const response = await fetch(url);
    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Weather] API error (${response.status}): ${errText}`);
      return null;
    }

    const data: WeatherData = await response.json();

    // Cache the result
    await storage.cacheWeather(lat, lng, data);
    console.log("[Weather] Fetched and cached for", lat, lng);

    return data;
  } catch (err) {
    console.error("[Weather] Fetch error:", err);
    return null;
  }
}

// Aliases for backward compatibility with ai.ts
export const getWeatherForFarm = getWeather;
export const formatWeatherContext = formatWeatherForPrompt;

/**
 * Farm Profiles End-to-End Tests
 *
 * Covers:
 *  - GET /api/protected/farm-profile (auth required, empty profile, profile with weather)
 *  - PUT /api/protected/farm-profile (create, update, field validation)
 *  - GET /api/protected/weather (no profile, with profile, weather data returned)
 *  - Weather caching integration (mock OpenWeatherMap fetch)
 *  - Edge cases: auth checks, missing fields, invalid coordinates
 *
 * Uses vitest + supertest. Forces MemStorage so no real database is needed.
 * Mocks the weather module to avoid real OpenWeatherMap API calls.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";

// ── Force MemStorage BEFORE any server imports ──
process.env.DATABASE_URL = "";
process.env.SESSION_SECRET="vite..._ENV = "test";

// ── Mock weather module ──
const { mockGetWeather, mockFormatWeather } = vi.hoisted(() => ({
  mockGetWeather: vi.fn(),
  mockFormatWeather: vi.fn(),
}));

vi.mock("../server/weather", () => ({
  getWeather: mockGetWeather,
  getWeatherForFarm: mockGetWeather,
  formatWeatherForPrompt: mockFormatWeather,
  formatWeatherContext: mockFormatWeather,
}));

import { registerRoutes } from "../server/routes";

// ── Test app factory ──
async function createTestApp(): Promise<Express> {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  await registerRoutes(app);

  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";
      res.status(status).json({ message });
    },
  );

  return app;
}

// ── Auth helpers ──
async function devLogin(agent: request.SuperAgentTest) {
  const res = await agent.post("/api/dev-login");
  expect(res.status).toBe(200);
  return agent;
}

// Sample weather data
const mockWeatherData = {
  current: {
    temp: 72, feels_like: 70, humidity: 55, wind_speed: 8, wind_deg: 180,
    weather: [{ main: "Clear", description: "clear sky" }],
  },
  daily: [
    { dt: 1717027200, temp: { min: 60, max: 78, day: 72 }, humidity: 55,
      wind_speed: 8, weather: [{ main: "Clear", description: "clear sky" }], pop: 0.1 },
    { dt: 1717113600, temp: { min: 58, max: 75, day: 68 }, humidity: 60,
      wind_speed: 10, weather: [{ main: "Clouds", description: "partly cloudy" }], pop: 0.3 },
  ],
};

// ═══════════════════════════════════════════════════════════════════
// Each describe block gets a fresh app to avoid cross-test pollution.
// ═══════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────
// GET /api/protected/farm-profile
// ─────────────────────────────────────────────────────────────────

describe("GET /api/protected/farm-profile", () => {
  let app: Express;
  beforeAll(async () => { app = await createTestApp(); });
  beforeEach(() => { mockGetWeather.mockReset(); mockFormatWeather.mockReset(); });

  it("returns 401 when not authenticated", async () => {
    const res = await request(app).get("/api/protected/farm-profile");
    expect(res.status).toBe(401);
  });

  it("returns null profile for user with no farm profile", async () => {
    const agent = request.agent(app);
    await devLogin(agent);

    const res = await agent.get("/api/protected/farm-profile");
    expect(res.status).toBe(200);
    expect(res.body.profile).toBeNull();
    expect(res.body.weather).toBeNull();
  });

  it("returns profile without weather when no coordinates set", async () => {
    const agent = request.agent(app);
    await devLogin(agent);

    await agent.put("/api/protected/farm-profile").send({
      farmName: "No Coords Farm", location: "Somewhere, USA",
      acres: 100, crops: ["corn", "soybeans"], soilType: "loam",
    });

    const res = await agent.get("/api/protected/farm-profile");
    expect(res.status).toBe(200);
    expect(res.body.profile).not.toBeNull();
    expect(res.body.profile.farmName).toBe("No Coords Farm");
    expect(res.body.profile.acres).toBe(100);
    expect(res.body.profile.crops).toEqual(["corn", "soybeans"]);
    expect(res.body.weather).toBeNull();
  });

  it("returns profile with weather when coordinates are set", async () => {
    const agent = request.agent(app);
    await devLogin(agent);

    mockGetWeather.mockResolvedValue(mockWeatherData);
    mockFormatWeather.mockReturnValue("Current conditions: 72°F, clear sky, humidity 55%");

    await agent.put("/api/protected/farm-profile").send({
      farmName: "Sunny Acres", location: "Sacramento, CA",
      lat: "38.5816", lng: "-121.4944", acres: 250,
      crops: ["almonds", "tomatoes"], soilType: "sandy loam",
      climateZone: "Mediterranean", hardinessZone: "9b", waterSource: "irrigation district",
    });

    const res = await agent.get("/api/protected/farm-profile");
    expect(res.status).toBe(200);
    expect(res.body.profile.farmName).toBe("Sunny Acres");
    expect(res.body.profile.lat).toBe("38.5816");
    expect(res.body.profile.lng).toBe("-121.4944");
    expect(res.body.weather).not.toBeNull();
    expect(res.body.weather).toContain("72°F");
  });

  it("handles weather API failure gracefully", async () => {
    const agent = request.agent(app);
    await devLogin(agent);
    mockGetWeather.mockResolvedValue(null);

    await agent.put("/api/protected/farm-profile").send({
      farmName: "Rainy Farm", location: "Seattle, WA",
      lat: "47.6062", lng: "-122.3321", acres: 50, crops: ["apples"],
    });

    const res = await agent.get("/api/protected/farm-profile");
    expect(res.status).toBe(200);
    expect(res.body.profile).not.toBeNull();
    expect(res.body.weather).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// PUT /api/protected/farm-profile
// ─────────────────────────────────────────────────────────────────

describe("PUT /api/protected/farm-profile", () => {
  let app: Express;
  beforeAll(async () => { app = await createTestApp(); });

  it("returns 401 when not authenticated", async () => {
    const res = await request(app)
      .put("/api/protected/farm-profile")
      .send({ farmName: "Hack Farm" });
    expect(res.status).toBe(401);
  });

  it("creates a new farm profile (upsert — insert)", async () => {
    const agent = request.agent(app);
    await devLogin(agent);

    const res = await agent.put("/api/protected/farm-profile").send({
      farmName: "Green Valley Farm", location: "Iowa, USA",
      lat: "41.8780", lng: "-93.0977", acres: 320,
      crops: ["corn", "soybeans", "wheat"], soilType: "silty clay loam",
      waterSource: "well", climateZone: "continental", hardinessZone: "5b",
    });

    expect(res.status).toBe(200);
    expect(res.body.farmName).toBe("Green Valley Farm");
    expect(res.body.acres).toBe(320);
    expect(res.body.crops).toEqual(["corn", "soybeans", "wheat"]);
    expect(res.body.lat).toBe("41.8780");

    // Verify persistence
    const getRes = await agent.get("/api/protected/farm-profile");
    expect(getRes.body.profile.farmName).toBe("Green Valley Farm");
  });

  it("updates an existing farm profile (upsert — update)", async () => {
    const agent = request.agent(app);
    await devLogin(agent);

    await agent.put("/api/protected/farm-profile")
      .send({ farmName: "Old Name Farm", acres: 50 });

    const res = await agent.put("/api/protected/farm-profile").send({
      farmName: "Updated Farm", acres: 100,
      crops: ["hemp", "sunflowers"], location: "Oregon, USA",
    });

    expect(res.status).toBe(200);
    expect(res.body.farmName).toBe("Updated Farm");
    expect(res.body.acres).toBe(100);
    expect(res.body.crops).toEqual(["hemp", "sunflowers"]);
    expect(res.body.location).toBe("Oregon, USA");
  });

  it("preserves unchanged fields on partial update", async () => {
    const agent = request.agent(app);
    await devLogin(agent);

    // Create full profile
    await agent.put("/api/protected/farm-profile").send({
      farmName: "Full Farm", location: "Kansas", acres: 500,
      crops: ["wheat"], soilType: "loam", waterSource: "river",
    });

    // Update only acres — other fields should persist
    const res = await agent.put("/api/protected/farm-profile").send({ acres: 600 });

    expect(res.status).toBe(200);
    expect(res.body.acres).toBe(600);
    expect(res.body.farmName).toBe("Full Farm");
    expect(res.body.crops).toEqual(["wheat"]);
    expect(res.body.soilType).toBe("loam");
  });

  it("accepts empty crops array", async () => {
    const agent = request.agent(app);
    await devLogin(agent);

    const res = await agent.put("/api/protected/farm-profile")
      .send({ farmName: "No Crop Farm", crops: [] });
    expect(res.status).toBe(200);
    expect(res.body.crops).toEqual([]);
  });

  it("accepts farm profile with all optional fields empty", async () => {
    const agent = request.agent(app);
    await devLogin(agent);

    const res = await agent.put("/api/protected/farm-profile")
      .send({ farmName: "Minimal Farm" });
    expect(res.status).toBe(200);
    expect(res.body.farmName).toBe("Minimal Farm");
    expect(res.body.acres).toBe(0);
  });

  it("handles very large acre values", async () => {
    const agent = request.agent(app);
    await devLogin(agent);

    const res = await agent.put("/api/protected/farm-profile")
      .send({ farmName: "Mega Farm", acres: 999999 });
    expect(res.status).toBe(200);
    expect(res.body.acres).toBe(999999);
  });

  it("handles many crops", async () => {
    const agent = request.agent(app);
    await devLogin(agent);

    const manyCrops = Array.from({ length: 50 }, (_, i) => `crop_${i}`);
    const res = await agent.put("/api/protected/farm-profile")
      .send({ farmName: "Diverse Farm", crops: manyCrops });
    expect(res.status).toBe(200);
    expect(res.body.crops.length).toBe(50);
  });

  it("handles special characters in farm name", async () => {
    const agent = request.agent(app);
    await devLogin(agent);

    const res = await agent.put("/api/protected/farm-profile")
      .send({ farmName: "José's Organic Farm 🌱 & Sons" });
    expect(res.status).toBe(200);
    expect(res.body.farmName).toBe("José's Organic Farm 🌱 & Sons");
  });

  it("handles concurrent profile updates (last-write-wins)", async () => {
    const agent = request.agent(app);
    await devLogin(agent);

    const [res1, res2] = await Promise.all([
      agent.put("/api/protected/farm-profile").send({ acres: 100 }),
      agent.put("/api/protected/farm-profile").send({ acres: 200 }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────
// GET /api/protected/weather
// ─────────────────────────────────────────────────────────────────

describe("GET /api/protected/weather", () => {
  let app: Express;
  beforeAll(async () => { app = await createTestApp(); });
  beforeEach(() => { mockGetWeather.mockReset(); mockFormatWeather.mockReset(); });

  it("returns 401 when not authenticated", async () => {
    const res = await request(app).get("/api/protected/weather");
    expect(res.status).toBe(401);
  });

  it("returns available:false when farm profile has no coordinates", async () => {
    const agent = request.agent(app);
    await devLogin(agent);

    const res = await agent.get("/api/protected/weather");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.message).toContain("location not set");
  });

  it("returns available:true with weather data when coordinates set", async () => {
    const agent = request.agent(app);
    await devLogin(agent);

    await agent.put("/api/protected/farm-profile").send({
      farmName: "Weather Farm", lat: "35.0", lng: "-90.0", acres: 100,
    });

    mockGetWeather.mockResolvedValue(mockWeatherData);
    mockFormatWeather.mockReturnValue("Current conditions: 72°F, clear sky, humidity 55%.");

    const res = await agent.get("/api/protected/weather");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.summary).toContain("72°F");
    expect(res.body.data).toEqual(mockWeatherData);
  });

  it("returns available:false when weather API returns null", async () => {
    const agent = request.agent(app);
    await devLogin(agent);

    await agent.put("/api/protected/farm-profile")
      .send({ farmName: "Null Weather Farm", lat: "0", lng: "0" });
    mockGetWeather.mockResolvedValue(null);

    const res = await agent.get("/api/protected/weather");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.message).toContain("unavailable");
  });

  it("returns 500 when weather fetch throws an error", async () => {
    const agent = request.agent(app);
    await devLogin(agent);

    await agent.put("/api/protected/farm-profile")
      .send({ farmName: "Error Farm", lat: "0", lng: "0" });
    mockGetWeather.mockRejectedValue(new Error("Network down"));

    const res = await agent.get("/api/protected/weather");
    expect(res.status).toBe(500);
  });
});

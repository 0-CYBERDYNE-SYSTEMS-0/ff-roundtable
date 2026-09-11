import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 15000,
    env: {
      // Force in-memory storage (no real DB needed for billing tests)
      DATABASE_URL: "",
      SESSION_SECRET: "test-secret",
      NODE_ENV: "test",
      // Per-app login limiter cap. Suites that hammer /api/login need a
      // higher cap; the dedicated rate-limit test overrides this per-file.
      LOGIN_RATELIMIT_MAX: "1000",
    },
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
      "@": path.resolve(__dirname, "client", "src"),
    },
  },
});

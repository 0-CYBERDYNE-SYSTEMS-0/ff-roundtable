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
    },
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
      "@": path.resolve(__dirname, "client", "src"),
    },
  },
});

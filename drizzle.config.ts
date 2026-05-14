import { defineConfig } from "drizzle-kit";

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.warn("⚠️  DATABASE_URL not set — drizzle-kit commands will fail until configured.");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: dbUrl || "postgresql://localhost:5432/farm_roundtable_dev",
  },
});

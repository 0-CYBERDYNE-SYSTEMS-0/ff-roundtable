import { execFileSync } from "node:child_process";

/** Only a hex commit id ever leaves the server (no env dump, no secrets). */
export function sanitizeSha(value: unknown): string {
  const v = String(value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(v) ? v.slice(0, 7) : "unknown";
}

let cached: string | null = null;
/** Commit resolved once at startup: BUILD_SHA / REPLIT_GIT_COMMIT if set, else git rev-parse. */
export function buildSha(run: () => string = () => execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 })): string {
  if (cached) return cached;
  const fromEnv = sanitizeSha(process.env.BUILD_SHA ?? process.env.REPLIT_GIT_COMMIT);
  if (fromEnv !== "unknown") return (cached = fromEnv);
  try { cached = sanitizeSha(run()); } catch { cached = "unknown"; }
  return cached;
}
export function resetBuildShaCache(): void { cached = null; }

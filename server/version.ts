import { execFileSync } from "node:child_process";

/** Only a hex commit id ever leaves the server (no env dump, no secrets). */
export function sanitizeSha(value: unknown): string {
  const v = String(value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(v) ? v.slice(0, 7) : "unknown";
}

// Replaced at build time by esbuild --define (see script/resolve-sha.mjs); undefined under tsx/vitest.
declare const __BUILD_SHA__: string | undefined;
/** Sha baked into dist/index.js by `npm run build` ("" when not bundled). */
export function bakedSha(): string {
  return typeof __BUILD_SHA__ === "string" ? __BUILD_SHA__ : "";
}

let cached: string | null = null;
/** Commit resolved once: runtime env (GIT_SHA / REPLIT_GIT_COMMIT / SOURCE_VERSION / BUILD_SHA), then the build-time baked sha, then git rev-parse, else "unknown". */
export function buildSha(run: () => string = () => execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }), baked: () => string = bakedSha): string {
  if (cached) return cached;
  for (const v of [process.env.GIT_SHA, process.env.REPLIT_GIT_COMMIT, process.env.SOURCE_VERSION, process.env.BUILD_SHA, baked()]) {
    const s = sanitizeSha(v);
    if (s !== "unknown") return (cached = s);
  }
  try { cached = sanitizeSha(run()); } catch { cached = "unknown"; }
  return cached;
}
export function resetBuildShaCache(): void { cached = null; }

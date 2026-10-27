// Prints the commit sha to bake into the server bundle at build time.
// Order: GIT_SHA / REPLIT_GIT_COMMIT / SOURCE_VERSION env, then `git rev-parse HEAD`, then "unknown".
import { execFileSync } from "node:child_process";
const ok = (v) => { const s = String(v ?? "").trim().toLowerCase(); return /^[0-9a-f]{7,40}$/.test(s) ? s : ""; };
let sha = ok(process.env.GIT_SHA) || ok(process.env.REPLIT_GIT_COMMIT) || ok(process.env.SOURCE_VERSION);
if (!sha) { try { sha = ok(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch {} }
process.stdout.write(sha || "unknown");

import { useEffect, useState } from "react";

/** Tiny build stamp (commit sha from GET /api/version) for QA. */
export function VersionFooter() {
  const [sha, setSha] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/version").then(r => (r.ok ? r.json() : null)).then(d => { if (alive && d && typeof d.sha === "string") setSha(d.sha); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!sha) return null;
  return (
    <div className="pointer-events-none fixed bottom-0 right-1 z-50 text-[10px] text-neutral-500" data-testid="build-version">build {sha}</div>
  );
}

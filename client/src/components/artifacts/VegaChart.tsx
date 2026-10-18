import { useEffect, useRef, useState } from "react";
import { parseVegaChart, themedVegaSpec } from "@shared/chart-artifact";

export default function VegaChart({ content }: { content: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);

  let chart: ReturnType<typeof parseVegaChart> = null;
  try { chart = parseVegaChart(JSON.parse(content)); } catch { /* Invalid JSON has a readable fallback. */ }
  const columns = chart ? Array.from(new Set(chart.data.flatMap(Object.keys))) : [];
  useEffect(() => {
    const target = host.current;
    if (!target) return;
    let cancelled = false;
    let finalize: (() => void) | undefined;
    setError("");
    const mount = document.createElement("div");
    target.replaceChildren(mount);
    void (async () => {
      try {
        const parsed = parseVegaChart(JSON.parse(content));
        if (!parsed) throw new Error("Invalid chart specification");
        const { default: embed } = await import("vega-embed");
        if (cancelled) return;
        const result = await embed(mount, themedVegaSpec(parsed, width), {
          mode: "vega-lite", renderer: "svg", ast: true, actions: { export: true, source: false, compiled: false, editor: false },
          // All data is inline; even malformed saved specs cannot trigger network loads.
          loader: {
            load: async () => { throw new Error("External chart resources are disabled"); },
            sanitize: async () => { throw new Error("External chart links are disabled"); },
            http: async () => { throw new Error("External chart resources are disabled"); },
            file: async () => { throw new Error("External chart resources are disabled"); },
          },
        });
        finalize = () => result.finalize();
        if (cancelled) finalize();
      } catch {
        if (!cancelled) setError("This visualization could not be rendered. Its data is available below.");
      }
    })();
    return () => { cancelled = true; finalize?.(); mount.remove(); };
  }, [content, width]);

  return (
    <div className="space-y-4">
      {chart?.description && <p className="text-sm leading-relaxed text-neutral-600">{chart.description}</p>}
      {error && <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">{error}</p>}
      <div ref={host} className="w-full overflow-x-auto rounded-lg bg-white p-1" aria-label={chart?.title || "Visualization"} />
      {chart && <>
        <p className="text-xs text-neutral-500">Sources: {chart.sources.map((source, index) => <span key={source}>{index > 0 && " · "}{/^https?:\/\//i.test(source) ? <a className="underline" href={source} target="_blank" rel="noopener noreferrer">{source}</a> : source}</span>)}</p>
        <details className="text-xs text-neutral-600">
          <summary className="cursor-pointer">View source data · {chart.data.length} rows</summary>
          {chart.data.length > 100 && <p className="mt-2">Showing the first 100 rows. Download the chart JSON for the complete dataset.</p>}
          <div className="mt-2 max-h-64 overflow-auto"><table className="w-full text-left"><thead><tr>{columns.map(key => <th key={key} className="p-2 border-b">{key}</th>)}</tr></thead><tbody>{chart.data.slice(0, 100).map((row, index) => <tr key={index}>{columns.map(key => <td key={key} className="p-2 border-b">{row[key] == null ? "—" : String(row[key])}</td>)}</tr>)}</tbody></table></div>
        </details>
      </>}
    </div>
  );
}

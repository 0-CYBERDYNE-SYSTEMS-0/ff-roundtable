/**
 * HTML artifacts run in an opaque-origin sandbox (allow-scripts WITHOUT
 * allow-same-origin), so expert-written scripts can draw interactive visuals
 * but cannot read the app's cookies, storage or DOM. A CSP blocks all network
 * access, so the visual must be self-contained.
 */
export const HTML_ARTIFACT_SANDBOX = "allow-scripts";
export const HTML_ARTIFACT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

export function buildHtmlArtifactDoc(content: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${HTML_ARTIFACT_CSP}"><meta charset="utf-8">`;
  const base = `<style>body{margin:0;padding:12px;font-family:system-ui,sans-serif;color:#253b36}</style>`;
  if (/<head[^>]*>/i.test(content)) return content.replace(/<head[^>]*>/i, m => `${m}${meta}${base}`);
  return `<!doctype html><html><head>${meta}${base}</head><body>${content}</body></html>`;
}

import { expect, it } from "vitest";
import { buildHtmlArtifactDoc, HTML_ARTIFACT_SANDBOX } from "../client/src/components/artifacts/html-artifact";
it("html artifacts keep scripts but stay isolated from the app and network", () => {
  expect(HTML_ARTIFACT_SANDBOX).toBe("allow-scripts");
  expect(HTML_ARTIFACT_SANDBOX).not.toContain("allow-same-origin");
  const doc = buildHtmlArtifactDoc("<svg width=10></svg><script>document.body.dataset.ok=1</script>");
  expect(doc).toContain("<script>");
  expect(doc).toContain("default-src 'none'");
  expect(buildHtmlArtifactDoc("<html><head><title>x</title></head><body></body></html>")).toMatch(/<head><meta http-equiv="Content-Security-Policy"/);
});

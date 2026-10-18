import { describe, expect, it } from "vitest";
import { formatJsonArtifact } from "../client/src/lib/format-json-artifact";

describe("formatJsonArtifact", () => {
  it("preserves malformed content without throwing", () => {
    const content = '{"rows":[{"value":1}';
    expect(formatJsonArtifact(content)).toEqual({ content, valid: false });
  });

  it("pretty-prints valid JSON", () => {
    expect(formatJsonArtifact('{"value":1}')).toEqual({ content: '{\n  "value": 1\n}', valid: true });
  });
});

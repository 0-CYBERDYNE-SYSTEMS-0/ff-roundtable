import { describe, expect, it } from "vitest";
import { requestPresentation } from "../client/src/lib/request-presentation";

describe("technical request disclosures", () => {
  const technical = '@[Research Analyst] Please create an evidence visualization. Use this dataset: [{"topic":"Leafminer evidence","status":"Unknown"}]. Return a chart fence with a Vega-Lite envelope.';
  it("uses the natural request as the summary", () => {
    expect(requestPresentation(technical)).toEqual({ summary: "Please create an evidence visualization." });

  });
  it.each([
    "What is the difference between elemental sulfur and sulfur dioxide?",
    "Please compare the evidence and explain uncertainty. ".repeat(50),
    "Could we make a Vega-Lite visualization of the available observations?",
    "Review the safety questions in this report without drawing conclusions.",
  ])("keeps ordinary natural-language requests expanded: %s", content => {
    expect(requestPresentation(content)).toBeNull();

  });
  it.each([
    '```json\n{"value":12}\n```',
    '```rust\nfn main() {}\n```',
    '~~~python\nprint("hello")\n~~~',
    '[1, 2, 3]',
    '[{"date":"2026-10-19"}]',
    '{"title":"Review"}',
    'Return the filetype and content in a JSON envelope.',
    'Create a calendar file. Use RFC5545, DTSTART and DTEND fields.',
  ])("collapses raw payloads and implementation rules: %s", content => {
    expect(requestPresentation(content)).not.toBeNull();
  });
  it("never uses raw code or a cut-off sentence as the visible summary", () => {
    expect(requestPresentation('Return JSON with {"spec":{}}.')).toEqual({ summary: "Request with technical details." });
    expect(requestPresentation("Create " + "a very detailed ".repeat(30) + '\n```json\n{}\n```')).toEqual({ summary: "Request with technical details." });
  });
});

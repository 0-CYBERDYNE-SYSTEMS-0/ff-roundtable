import { describe, expect, it } from "vitest";
import { parseNewCommand } from "../client/src/lib/new-command";

describe("parseNewCommand", () => {
  it("recognizes bare /new without a topic", () => {
    expect(parseNewCommand("/new")).toBe("");
  });

  it("returns the trimmed topic from /new <topic>", () => {
    expect(parseNewCommand("  /new   Revisit crop rotation  ")).toBe("Revisit crop rotation");
  });

  it("leaves ordinary text alone", () => {
    expect(parseNewCommand("/newspaper is ready")).toBeNull();
  });
});

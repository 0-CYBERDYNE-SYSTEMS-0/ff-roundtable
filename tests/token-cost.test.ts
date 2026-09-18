/**
 * F2 — Autonomous loop token cost tests (SPEC_DOGFOOD_GAP_REMEDIATION.md §F2)
 *
 * Covers:
 *  - text-similarity: word-trigram Jaccard + > 0.8 redundancy stop rule
 *  - isDuplicateUserSubmission: POST /messages duplicate gate decision
 *  - makeAnalyzedBeforePredicate: user-uploaded images are "already analyzed"
 *    once an assistant message exists after the upload; expert files never are
 *  - collectImageParts: analyzed images become text notes, never base64; the
 *    2-part limit applies only to newly-embedded images
 *  - Message building (both call paths): an analyzed image produces NO image
 *    part and the "[Image ... — analyzed earlier in this conversation]" note;
 *    an expert-generated image is still embedded even with later assistant turns
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import path from "path";
import fs from "node:fs";

// ── Force MemStorage + test env BEFORE server imports ──
process.env.DATABASE_URL = "";
process.env.SESSION_SECRET = "vitest-token-cost-secret";
process.env.NODE_ENV = "test";

// ── Mock fetch BEFORE importing server modules that call providers ──
const mockFetch = vi.fn();
global.fetch = mockFetch;

import {
  trigramJaccard,
  wordTrigrams,
  shouldStopForRedundancy,
  REDUNDANCY_STOP_SIMILARITY_THRESHOLD,
  isDuplicateUserSubmission,
} from "../server/text-similarity";
import {
  collectImageParts,
  makeAnalyzedBeforePredicate,
  analyzedImageNote,
  isUserUpload,
  MAX_IMAGE_PARTS,
} from "../server/image-context";
import { getExpertResponse, getExpertResponseStream } from "../server/ai";
import type { Expert, File, Message } from "@shared/schema";

// ── Temp fixture dir under cwd (fileUrl resolves via path.join(cwd, rel)) ──
const TMP_DIR = fs.mkdtempSync(path.join(process.cwd(), ".tmp-token-cost-test-"));

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── Helpers ──
function writeFixture(name: string, bytes: Buffer | string): string {
  const filePath = path.join(TMP_DIR, name);
  fs.writeFileSync(filePath, bytes);
  return "/" + path.relative(process.cwd(), filePath);
}

function makeFile(opts: {
  name: string;
  fileType: string;
  fileUrl: string;
  uploadedAt: Date;
  uploadedBy?: string;
  id?: number;
}): File {
  return {
    id: opts.id ?? 1,
    conversationId: 1,
    filename: opts.name,
    fileUrl: opts.fileUrl,
    fileType: opts.fileType,
    uploadedBy: opts.uploadedBy ?? "user",
    uploadedAt: opts.uploadedAt,
  };
}

function makeImageFile(opts: {
  name: string;
  uploadedAt: Date;
  uploadedBy?: string;
  bytes?: Buffer | string;
  id?: number;
}): File {
  return makeFile({
    name: opts.name,
    fileType: "image/png",
    fileUrl: writeFixture(opts.name, opts.bytes ?? `${opts.name}-bytes`),
    uploadedAt: opts.uploadedAt,
    uploadedBy: opts.uploadedBy,
    id: opts.id,
  });
}

function makeMessage(opts: {
  id: number;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}): Message {
  return {
    id: opts.id,
    conversationId: 1,
    expertId: null,
    userId: null,
    content: opts.content,
    role: opts.role,
    expertName: opts.role === "assistant" ? "Terra" : null,
    expertRole: opts.role === "assistant" ? "Imagery Specialist" : null,
    artifacts: [],
    timestamp: opts.timestamp,
  };
}

function makeImageryExpert(model = "openai/gpt-4o"): Expert {
  return {
    id: 7,
    conversationId: 1,
    name: "Terra",
    role: "Imagery Specialist",
    model,
    systemPrompt: "You are Terra, an Imagery Specialist.",
    customInstructions: null,
    avatarUrl: null,
  };
}

function okChatResponse(content = "Acknowledged.") {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { role: "assistant", content } }],
    }),
  };
}

function sseStreamResponse(content: string) {
  const encoder = new TextEncoder();
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    `data: [DONE]\n\n`,
  ];
  let i = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: encoder.encode(chunks[i++]) }
            : { done: true as const, value: undefined },
        releaseLock: () => {},
      }),
    },
  };
}

/** Last (user) message from the single fetch call's JSON body. */
function lastFetchedMessage() {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  return body.messages[body.messages.length - 1];
}

function fetchedSystemContext(): string {
  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  const sys = body.messages.filter((m: { role: string }) => m.role === "system");
  return sys.map((m: { content: string }) => m.content).join("\n");
}

// ─────────────────────────────────────────────────────────────────
// Redundancy early-stop: similarity + stop rule
// ─────────────────────────────────────────────────────────────────

describe("trigramJaccard", () => {
  it("gives 1 for identical text regardless of case/punctuation", () => {
    const a = "Nitrogen deficiency shows as yellowing lower leaves.";
    const b = "NITROGEN deficiency shows as yellowing lower leaves!";
    expect(trigramJaccard(a, b)).toBe(1);
  });

  it("gives 0 for disjoint text", () => {
    expect(trigramJaccard("cattle rotation grazing paddocks", "boron soil test laboratory")).toBe(0);
  });

  it("scores a near-identical rewording above 0.8", () => {
    const a =
      "Based on the soil test results I recommend applying forty units of nitrogen before planting and splitting the application into two passes to reduce leaching";
    const b =
      "Based on the soil test results I recommend applying forty units of nitrogen before planting and splitting the application into two passes to reduce losses";
    expect(trigramJaccard(a, b)).toBeGreaterThan(0.8);
  });

  it("scores a genuinely different answer below 0.8", () => {
    const a =
      "Your pH is 5.8, so lime at two tons per acre this fall and retest in spring before deciding on fertilizer.";
    const b =
      "The drone imagery shows uneven canopy; check the irrigation nozzle pattern and scout the northwest corner for spider mites this week.";
    expect(trigramJaccard(a, b)).toBeLessThan(0.8);
  });

  it("treats short identical messages as 1 and different short ones as 0", () => {
    expect(trigramJaccard("Sounds good", "sounds good")).toBe(1);
    expect(trigramJaccard("yes", "no")).toBe(0);
  });

  it("wordTrigrams falls back to unigrams below three words", () => {
    expect(wordTrigrams("yes boss")).toEqual(new Set(["yes", "boss"]));
    expect(wordTrigrams("one two three four")).toEqual(
      new Set(["one two three", "two three four"])
    );
  });
});

describe("shouldStopForRedundancy", () => {
  // 17-word base; changing ONLY the final word alters one word-trigram of 15
  // → similarity 14/16 = 0.875, safely above the 0.8 default threshold.
  const priorA =
    "Apply lime at two tons per acre this fall and retest the soil in spring before planting";
  const nearIdentical =
    "Apply lime at two tons per acre this fall and retest the soil in spring before sowing";
  const different = "Scout for aphids on the winter wheat and check the grain drill calibration.";

  it("stops when a new autonomous turn exceeds the 0.8 threshold against any prior message", () => {
    const decision = shouldStopForRedundancy(nearIdentical, [priorA, different]);
    expect(decision.stop).toBe(true);
    expect(decision.maxSimilarity).toBeGreaterThan(REDUNDANCY_STOP_SIMILARITY_THRESHOLD);
    expect(decision.matchedIndex).toBe(0);
  });

  it("does not stop when all prior messages are below the threshold", () => {
    const decision = shouldStopForRedundancy(different, [priorA]);
    expect(decision.stop).toBe(false);
  });

  it("never stops on an empty prior set (e.g. first autonomous turn)", () => {
    const decision = shouldStopForRedundancy(priorA, []);
    expect(decision.stop).toBe(false);
    expect(decision.matchedIndex).toBe(-1);
  });

  it("uses strict inequality: similarity equal to the threshold does not stop", () => {
    const similarity = trigramJaccard(nearIdentical, priorA);
    expect(shouldStopForRedundancy(nearIdentical, [priorA], similarity).stop).toBe(false);
    expect(shouldStopForRedundancy(nearIdentical, [priorA], similarity - 0.001).stop).toBe(true);
  });

  it("honors a custom (conservative) threshold", () => {
    expect(shouldStopForRedundancy(nearIdentical, [priorA], 0.95).stop).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// Duplicate-submission gate decision
// ─────────────────────────────────────────────────────────────────

describe("isDuplicateUserSubmission", () => {
  const lastUserMsg = { content: "What seed variety should I plant?", role: "user" };

  it("flags an identical resend of the last user message", () => {
    expect(isDuplicateUserSubmission("What seed variety should I plant?", lastUserMsg, false)).toBe(true);
  });

  it("ignores surrounding whitespace when comparing", () => {
    expect(isDuplicateUserSubmission("  What seed variety should I plant?  ", lastUserMsg, false)).toBe(true);
  });

  it("does not fire when the last message is from an expert", () => {
    expect(
      isDuplicateUserSubmission(
        "What seed variety should I plant?",
        { content: "What seed variety should I plant?", role: "assistant" },
        false
      )
    ).toBe(false);
  });

  it("does not fire when new files are attached", () => {
    expect(isDuplicateUserSubmission("What seed variety should I plant?", lastUserMsg, true)).toBe(false);
  });

  it("does not fire for different content or a missing last message", () => {
    expect(isDuplicateUserSubmission("Different question now", lastUserMsg, false)).toBe(false);
    expect(isDuplicateUserSubmission("What seed variety should I plant?", null, false)).toBe(false);
    expect(isDuplicateUserSubmission("", lastUserMsg, false)).toBe(false);
    expect(isDuplicateUserSubmission(undefined, lastUserMsg, false)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// Analyze-image-once predicate
// ─────────────────────────────────────────────────────────────────

describe("makeAnalyzedBeforePredicate", () => {
  const upload = new Date("2026-09-15T10:00:00Z");

  it("marks a user-uploaded image analyzed once an assistant message follows the upload", () => {
    const history = [
      makeMessage({ id: 1, role: "user", content: "[Uploaded file: field.png]", timestamp: upload }),
      makeMessage({ id: 2, role: "assistant", content: "I see emergence issues.", timestamp: new Date(upload.getTime() + 60_000) }),
    ];
    const isAnalyzed = makeAnalyzedBeforePredicate(history);
    const img = makeImageFile({ name: "field.png", uploadedAt: upload });
    expect(isAnalyzed(img)).toBe(true);
  });

  it("keeps a fresh user upload un-analyzed when no assistant message follows", () => {
    const history = [
      makeMessage({ id: 1, role: "user", content: "hi", timestamp: new Date(upload.getTime() - 60_000) }),
      makeMessage({ id: 2, role: "assistant", content: "Hello!", timestamp: new Date(upload.getTime() - 30_000) }),
    ];
    const img = makeImageFile({ name: "fresh.png", uploadedAt: upload });
    expect(makeAnalyzedBeforePredicate(history)(img)).toBe(false);
  });

  it("never marks expert-generated files as analyzed, even with later assistant messages", () => {
    const history = [
      makeMessage({ id: 2, role: "assistant", content: "Generated a chart.", timestamp: new Date(upload.getTime() + 60_000) }),
    ];
    const isAnalyzed = makeAnalyzedBeforePredicate(history);
    expect(isAnalyzed(makeImageFile({ name: "gen.png", uploadedAt: upload, uploadedBy: "ai" }))).toBe(false);
    expect(isAnalyzed(makeImageFile({ name: "fc.png", uploadedAt: upload, uploadedBy: "Expert: File Creator" }))).toBe(false);
  });

  it("treats files without an upload timestamp as not yet analyzed", () => {
    const history = [
      makeMessage({ id: 2, role: "assistant", content: "reply", timestamp: new Date() }),
    ];
    const file = makeImageFile({ name: "nodate.png", uploadedAt: upload });
    const noDate = { ...file, uploadedAt: null } as File;
    expect(makeAnalyzedBeforePredicate(history)(noDate)).toBe(false);
  });

  it("isUserUpload matches the upload route's uploadedBy marker", () => {
    expect(isUserUpload(makeImageFile({ name: "a.png", uploadedAt: upload, uploadedBy: "user" }))).toBe(true);
    expect(isUserUpload(makeImageFile({ name: "b.png", uploadedAt: upload, uploadedBy: "ai" }))).toBe(false);
  });

  it("analyzedImageNote uses the spec'd wording", () => {
    expect(analyzedImageNote("field.png")).toBe(
      '[Image "field.png" — analyzed earlier in this conversation]'
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// collectImageParts with the predicate
// ─────────────────────────────────────────────────────────────────

describe("collectImageParts analyze-once behavior", () => {
  it("excludes already-analyzed images from parts and lists them separately", async () => {
    const analyzed = makeImageFile({ name: "old.png", uploadedAt: new Date("2026-09-15T10:00:00Z"), id: 1 });
    const fresh = makeImageFile({ name: "new.png", uploadedAt: new Date("2026-09-15T11:00:00Z"), id: 2 });
    const isAnalyzed = () => true;

    const { parts, skipped, alreadyAnalyzed } = await collectImageParts([analyzed, fresh], MAX_IMAGE_PARTS, isAnalyzed);

    expect(alreadyAnalyzed).toEqual(["new.png", "old.png"]); // most recent first
    expect(skipped).toEqual([]);
    expect(parts).toEqual([]);
  });

  it("applies the 2-part limit only to newly-embedded images", async () => {
    const analyzedA = makeImageFile({ name: "a1.png", uploadedAt: new Date("2026-09-15T09:00:00Z"), id: 1 });
    const analyzedB = makeImageFile({ name: "a2.png", uploadedAt: new Date("2026-09-15T09:30:00Z"), id: 2 });
    const freshA = makeImageFile({ name: "f1.png", uploadedAt: new Date("2026-09-15T10:00:00Z"), id: 3 });
    const freshB = makeImageFile({ name: "f2.png", uploadedAt: new Date("2026-09-15T10:30:00Z"), id: 4 });
    const analyzedNames = new Set(["a1.png", "a2.png"]);
    const isAnalyzed = (f: File) => analyzedNames.has(f.filename);

    const { parts, alreadyAnalyzed } = await collectImageParts(
      [analyzedA, analyzedB, freshA, freshB],
      MAX_IMAGE_PARTS,
      isAnalyzed
    );

    expect(alreadyAnalyzed).toEqual(["a2.png", "a1.png"]); // most recent first
    expect(parts).toHaveLength(2);
    expect(Buffer.from(parts[0].image_url.url.split(",")[1], "base64").toString()).toBe("f2.png-bytes");
    expect(Buffer.from(parts[1].image_url.url.split(",")[1], "base64").toString()).toBe("f1.png-bytes");
  });

  it("keeps current behavior when no predicate is passed", async () => {
    const img = makeImageFile({ name: "plain.png", uploadedAt: new Date(), id: 5 });
    const { parts, skipped, alreadyAnalyzed } = await collectImageParts([img]);
    expect(parts).toHaveLength(1);
    expect(skipped).toEqual([]);
    expect(alreadyAnalyzed).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────
// Message building: analyzed images become a text note, not base64
// ─────────────────────────────────────────────────────────────────

describe("expert turns re-use analyzed images as text (non-stream path)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    process.env.OPENROUTER_API_KEY = "test-key";
  });

  it("sends no image part and a text note for an already-analyzed user upload", async () => {
    const uploadedAt = new Date("2026-09-15T10:00:00Z");
    const png = makeImageFile({ name: "field.png", uploadedAt, bytes: "field-payload", id: 11 });
    const history = [
      makeMessage({ id: 1, role: "user", content: "Here is my field photo", timestamp: uploadedAt }),
      makeMessage({ id: 2, role: "assistant", content: "I see emergence issues.", timestamp: new Date(uploadedAt.getTime() + 60_000) }),
    ];

    mockFetch.mockResolvedValueOnce(okChatResponse("Noted."));

    await getExpertResponse(makeImageryExpert(), history, "Anything else?", [png], ["Imagery Specialist"]);

    const userMsg = lastFetchedMessage();
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toBe("Anything else?"); // plain string — zero image parts

    const context = fetchedSystemContext();
    expect(context).toContain('[Image "field.png" — analyzed earlier in this conversation]');
    expect(context).not.toContain("delivered visually");
    expect(context).not.toContain(Buffer.from("field-payload").toString("base64"));
  });

  it("still embeds a user-uploaded image that has not been analyzed yet", async () => {
    const uploadedAt = new Date("2026-09-15T10:00:00Z");
    const png = makeImageFile({ name: "fresh.png", uploadedAt, bytes: "fresh-payload", id: 12 });
    const history = [
      makeMessage({ id: 1, role: "user", content: "What is this?", timestamp: uploadedAt }),
    ];

    mockFetch.mockResolvedValueOnce(okChatResponse("A tractor."));

    await getExpertResponse(makeImageryExpert(), history, "What is this?", [png], ["Imagery Specialist"]);

    const userMsg = lastFetchedMessage();
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content[1].type).toBe("image_url");
    expect(userMsg.content[1].image_url.url).toBe(
      `data:image/png;base64,${Buffer.from("fresh-payload").toString("base64")}`
    );
    expect(fetchedSystemContext()).toContain("[Image attached: fresh.png — delivered visually]");
  });

  it("keeps embedding expert-generated images even after assistant replies", async () => {
    const generatedAt = new Date("2026-09-15T10:00:00Z");
    const png = makeImageFile({
      name: "chart.png",
      uploadedAt: generatedAt,
      uploadedBy: "Expert: File Creator",
      bytes: "chart-payload",
      id: 13,
    });
    const history = [
      makeMessage({ id: 2, role: "assistant", content: "Created chart.png for you.", timestamp: new Date(generatedAt.getTime() + 60_000) }),
    ];

    mockFetch.mockResolvedValueOnce(okChatResponse("Here is the chart."));

    await getExpertResponse(makeImageryExpert(), history, "Explain the chart", [png], ["Imagery Specialist"]);

    const userMsg = lastFetchedMessage();
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content[1].image_url.url).toBe(
      `data:image/png;base64,${Buffer.from("chart-payload").toString("base64")}`
    );
  });

  it("stream path also sends the analyzed-image note instead of base64", async () => {
    const uploadedAt = new Date("2026-09-15T10:00:00Z");
    const png = makeImageFile({ name: "drone.png", uploadedAt, bytes: "drone-payload", id: 14 });
    const history = [
      makeMessage({ id: 1, role: "user", content: "drone shot", timestamp: uploadedAt }),
      makeMessage({ id: 2, role: "assistant", content: "Canopy looks thin.", timestamp: new Date(uploadedAt.getTime() + 60_000) }),
    ];
    const tokens: string[] = [];

    mockFetch.mockResolvedValueOnce(sseStreamResponse("Standing by."));

    await getExpertResponseStream(
      makeImageryExpert(),
      history,
      "Continue",
      [png],
      ["Imagery Specialist"],
      (t) => tokens.push(t)
    );

    const userMsg = lastFetchedMessage();
    expect(userMsg.content).toBe("Continue"); // no multimodal array when nothing is embedded
    const context = fetchedSystemContext();
    expect(context).toContain('[Image "drone.png" — analyzed earlier in this conversation]');
    expect(context).not.toContain(Buffer.from("drone-payload").toString("base64"));
  });
});

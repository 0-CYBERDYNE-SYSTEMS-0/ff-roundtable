/**
 * Track B — Uploaded-Image Analysis Tests (SPEC_CALENDAR_AND_VISION.md §B6)
 *
 * Covers:
 *  - collectImageParts: 2-part limit, most-recent-first order, 5 MB raw cap,
 *    non-image filtering, missing-file skip (never throws), data-URL prefix
 *  - Message building (non-stream path): user message becomes a multimodal
 *    content array with image_url parts; text files stay inline in the
 *    Attached Files Context; image listed as delivered visually
 *  - 12k-char truncation applies to the text part only — base64 survives
 *  - Stream path also delivers image parts in the user content array
 *  - B4 honest failure: vision-looking provider 4xx → explicit per-expert
 *    message; non-vision errors keep the generic error path
 *  - B5 prompt nudge for the Imagery Specialist
 *
 * Temp files live in a throwaway directory under process.cwd() (the disk-path
 * convention resolves fileUrl against cwd) and are removed in afterAll.
 * The real uploads/ directory is never touched.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import path from "path";
import fs from "node:fs";

// ── Force MemStorage + test env BEFORE server imports ──
process.env.DATABASE_URL = "";
process.env.SESSION_SECRET = "vitest-image-analysis-secret";
process.env.NODE_ENV = "test";

// ── Mock fetch BEFORE importing server modules that call providers ──
const mockFetch = vi.fn();
global.fetch = mockFetch;

import { collectImageParts, MAX_IMAGE_PARTS } from "../server/image-context";
import {
  getExpertResponse,
  getExpertResponseStream,
  generateSystemPrompt,
} from "../server/ai";
import type { Expert, File } from "@shared/schema";

// ── Temp fixture dir under cwd (fileUrl resolves via path.join(cwd, rel)) ──
const TMP_DIR = fs.mkdtempSync(path.join(process.cwd(), ".tmp-vision-test-"));

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── Helpers ──
function writeFixture(name: string, bytes: Buffer | string): string {
  const filePath = path.join(TMP_DIR, name);
  fs.writeFileSync(filePath, bytes);
  // Mirror the uploads/ convention: root-relative URL resolved against cwd.
  return "/" + path.relative(process.cwd(), filePath);
}

function makeFile(opts: {
  name: string;
  fileType: string;
  fileUrl: string;
  uploadedAt: Date;
  id?: number;
}): File {
  return {
    id: opts.id ?? 1,
    conversationId: 1,
    filename: opts.name,
    fileUrl: opts.fileUrl,
    fileType: opts.fileType,
    uploadedBy: "Farmer",
    uploadedAt: opts.uploadedAt,
  };
}

function makeImageFile(name: string, bytes: Buffer | string, uploadedAt: Date, id = 1): File {
  return makeFile({
    name,
    fileType: "image/png",
    fileUrl: writeFixture(name, bytes),
    uploadedAt,
    id,
  });
}

function makeImageryExpert(model = "deepseek/deepseek-v3:free"): Expert {
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

function okChatResponse(content = "I see a healthy field.") {
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

function errorResponse(status: number, message: string) {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify({ error: { message } }),
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
// collectImageParts unit tests
// ─────────────────────────────────────────────────────────────────

describe("collectImageParts", () => {
  it("collects at most 2 images, most recent first, in order", async () => {
    const oldest = makeImageFile("old.png", "oldest-bytes", new Date(Date.now() - 30000), 1);
    const newest = makeImageFile("new.png", "newest-bytes", new Date(Date.now() - 5000), 2);
    const middle = makeImageFile("mid.png", "middle-bytes", new Date(Date.now() - 15000), 3);

    const { parts, skipped } = await collectImageParts([oldest, middle, newest]);

    expect(parts).toHaveLength(MAX_IMAGE_PARTS);
    expect(skipped).toEqual([]);

    // Most recent first: newest, then middle — oldest dropped by the limit.
    expect(parts[0].type).toBe("image_url");
    expect(Buffer.from(parts[0].image_url.url.split(",")[1], "base64").toString()).toBe("newest-bytes");
    expect(Buffer.from(parts[1].image_url.url.split(",")[1], "base64").toString()).toBe("middle-bytes");
  });

  it("returns data:<mime>;base64,<...> URLs", async () => {
    const img = makeImageFile("shot.png", Buffer.from([1, 2, 3, 4]), new Date());
    const { parts } = await collectImageParts([img]);
    expect(parts[0].image_url.url).toBe(
      `data:image/png;base64,${Buffer.from([1, 2, 3, 4]).toString("base64")}`
    );
  });

  it("skips images over 5 MB raw without throwing", async () => {
    const big = makeImageFile(
      "big.png",
      Buffer.alloc(5 * 1024 * 1024 + 1, 7),
      new Date()
    );
    const small = makeImageFile("small.png", "tiny", new Date(), 2);

    const { parts, skipped } = await collectImageParts([big, small]);

    expect(skipped).toEqual(["big.png"]);
    expect(parts).toHaveLength(1);
    expect(Buffer.from(parts[0].image_url.url.split(",")[1], "base64").toString()).toBe("tiny");
  });

  it("filters out non-image files", async () => {
    const csv = makeFile({
      name: "notes.csv",
      fileType: "text/csv",
      fileUrl: writeFixture("notes.csv", "week,n\n1,5\n"),
      uploadedAt: new Date(),
    });
    const img = makeImageFile("only.png", "img-bytes", new Date(), 2);

    const { parts, skipped } = await collectImageParts([csv, img]);

    expect(skipped).toEqual([]);
    expect(parts).toHaveLength(1);
    expect(parts[0].image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("skips missing files without throwing", async () => {
    const ghost = makeFile({
      name: "ghost.png",
      fileType: "image/png",
      fileUrl: `/${path.relative(process.cwd(), path.join(TMP_DIR, "does-not-exist.png"))}`,
      uploadedAt: new Date(),
    });

    const { parts, skipped } = await collectImageParts([ghost]);

    expect(parts).toEqual([]);
    expect(skipped).toEqual(["ghost.png"]);
  });
});

// ─────────────────────────────────────────────────────────────────
// Message building — non-stream path (getExpertResponse)
// ─────────────────────────────────────────────────────────────────

describe("expert message building with images (non-stream path)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    process.env.OPENROUTER_API_KEY = "test-key";
  });

  it("sends the user message as a multimodal array with image parts; text files unchanged", async () => {
    const csv = makeFile({
      name: "notes.csv",
      fileType: "text/csv",
      fileUrl: writeFixture("notes.csv", "week,nitrogen\n1,45\n"),
      uploadedAt: new Date(Date.now() - 60000),
    });
    const png = makeImageFile("photo.png", "png-bytes-here", new Date(), 2);

    mockFetch.mockResolvedValueOnce(okChatResponse("Looks like nitrogen stress."));

    await getExpertResponse(makeImageryExpert(), [], "What do you see?", [csv, png], ["Imagery Specialist"]);

    const userMsg = lastFetchedMessage();
    expect(userMsg.role).toBe("user");
    expect(Array.isArray(userMsg.content)).toBe(true);

    const [textPart, imagePart, ...rest] = userMsg.content;
    expect(rest).toEqual([]);
    expect(textPart).toEqual({ type: "text", text: "What do you see?" });
    expect(imagePart.type).toBe("image_url");
    expect(imagePart.image_url.url).toBe(
      `data:image/png;base64,${Buffer.from("png-bytes-here").toString("base64")}`
    );

    // Text file content still inlined; image listed as delivered visually.
    const context = fetchedSystemContext();
    expect(context).toContain("--- Attached Files Context ---");
    expect(context).toContain("notes.csv");
    expect(context).toContain("week,nitrogen");
    expect(context).toContain("[Image attached: photo.png — delivered visually]");
  });

  it("keeps plain string user content when no images are attached", async () => {
    const csv = makeFile({
      name: "notes.csv",
      fileType: "text/csv",
      fileUrl: writeFixture("notes2.csv", "a,b\n1,2\n"),
      uploadedAt: new Date(),
    });

    mockFetch.mockResolvedValueOnce(okChatResponse());

    await getExpertResponse(makeImageryExpert(), [], "Hello", [csv], ["Imagery Specialist"]);

    const userMsg = lastFetchedMessage();
    expect(userMsg.content).toBe("Hello");
  });

  it("truncates only the text part — the base64 image part survives verbatim", async () => {
    const png = makeImageFile("photo.png", "image-payload", new Date());
    const longText = "x".repeat(15_000);

    mockFetch.mockResolvedValueOnce(okChatResponse());

    await getExpertResponse(makeImageryExpert(), [], longText, [png], ["Imagery Specialist"]);

    const userMsg = lastFetchedMessage();
    const [textPart, imagePart] = userMsg.content;

    expect(textPart.type).toBe("text");
    expect(textPart.text.endsWith("... [Content Truncated] ...")).toBe(true);
    expect(textPart.text.length).toBeLessThan(15_000);

    // Base64 part untouched by the 12k truncation.
    expect(imagePart.image_url.url).toBe(
      `data:image/png;base64,${Buffer.from("image-payload").toString("base64")}`
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// Message building — stream path (getExpertResponseStream)
// ─────────────────────────────────────────────────────────────────

describe("expert message building with images (stream path)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    process.env.OPENROUTER_API_KEY = "test-key";
  });

  it("delivers image parts in the stream path user content array", async () => {
    const png = makeImageFile("drone.png", "drone-shot", new Date());
    const tokens: string[] = [];

    mockFetch.mockResolvedValueOnce(sseStreamResponse("Healthy canopy."));

    const result = await getExpertResponseStream(
      makeImageryExpert(),
      [],
      "Analyze this drone shot",
      [png],
      ["Imagery Specialist"],
      (t) => tokens.push(t)
    );

    expect(result.content).toBe("Healthy canopy.");
    expect(tokens).toContain("Healthy canopy.");

    const userMsg = lastFetchedMessage();
    expect(userMsg.role).toBe("user");
    expect(userMsg.content[0]).toEqual({ type: "text", text: "Analyze this drone shot" });
    expect(userMsg.content[1].type).toBe("image_url");
    expect(userMsg.content[1].image_url.url).toBe(
      `data:image/png;base64,${Buffer.from("drone-shot").toString("base64")}`
    );

    expect(fetchedSystemContext()).toContain("[Image attached: drone.png — delivered visually]");
  });
});

// ─────────────────────────────────────────────────────────────────
// B4 — honest failure on vision-rejecting models
// ─────────────────────────────────────────────────────────────────

describe("honest vision failure", () => {
  const HONEST_MSG =
    "⚠️ Terra could not analyze the image — this model doesn't accept image input. Try a vision-capable model (e.g. switch this expert to one, or use BYOK).";

  beforeEach(() => {
    mockFetch.mockReset();
    process.env.OPENROUTER_API_KEY = "test-key";
  });

  it("replaces a vision-looking 400 with the honest per-expert message (non-stream)", async () => {
    const png = makeImageFile("photo.png", "bytes", new Date());
    mockFetch.mockResolvedValueOnce(
      errorResponse(400, "Image input is not supported by this model")
    );

    const result = await getExpertResponse(
      makeImageryExpert("openai/gpt-3.5-turbo"),
      [],
      "What is this?",
      [png],
      ["Imagery Specialist"]
    );

    expect(result.content).toBe(HONEST_MSG);
  });

  it("same honest message on the stream path", async () => {
    const png = makeImageFile("photo.png", "bytes", new Date());
    const tokens: string[] = [];
    mockFetch.mockResolvedValueOnce(
      errorResponse(422, "This model does not support image/multimodal input")
    );

    const result = await getExpertResponseStream(
      makeImageryExpert("openai/gpt-3.5-turbo"),
      [],
      "What is this?",
      [png],
      ["Imagery Specialist"],
      (t) => tokens.push(t)
    );

    expect(result.content).toBe(HONEST_MSG);
    expect(tokens).toContain(HONEST_MSG);
  });

  it("the next expert still responds after a vision failure", async () => {
    const png = makeImageFile("photo.png", "bytes", new Date());

    // Expert 1: vision-rejecting model → honest failure turn…
    mockFetch.mockResolvedValueOnce(
      errorResponse(400, "messages with images are not supported")
    );
    const failed = await getExpertResponse(
      makeImageryExpert("openai/gpt-3.5-turbo"),
      [],
      "What is this?",
      [png],
      ["Imagery Specialist", "Soil Scientist"]
    );
    expect(failed.content).toBe(HONEST_MSG);

    // …expert 2 (vision-capable) succeeds on the very next call.
    mockFetch.mockResolvedValueOnce(okChatResponse("The image shows erosion."));
    const fine = await getExpertResponse(
      { ...makeImageryExpert(), id: 8, name: "Sam", role: "Soil Scientist", model: "openai/gpt-4o" },
      [],
      "What is this?",
      [png],
      ["Imagery Specialist", "Soil Scientist"]
    );
    expect(fine.content).toBe("The image shows erosion.");
  });

  it("does not swallow non-vision errors (500, or 400 without vision keywords)", async () => {
    const png = makeImageFile("photo.png", "bytes", new Date());

    mockFetch.mockResolvedValueOnce(errorResponse(500, "Internal server error"));
    const serverError = await getExpertResponse(
      makeImageryExpert(), [], "Hi", [png], ["Imagery Specialist"]
    );
    expect(serverError.content).toMatch(/^\(Error generating response for Terra:/);
    expect(serverError.content).toContain("500");

    mockFetch.mockResolvedValueOnce(errorResponse(400, "Insufficient credits"));
    const creditError = await getExpertResponse(
      makeImageryExpert(), [], "Hi", [png], ["Imagery Specialist"]
    );
    expect(creditError.content).toMatch(/^\(Error generating response for Terra:/);

    // A vision-looking 400 on a turn WITHOUT image parts must also stay generic.
    mockFetch.mockResolvedValueOnce(errorResponse(400, "image something"));
    const noImage = await getExpertResponse(
      makeImageryExpert(), [], "Hi", [], ["Imagery Specialist"]
    );
    expect(noImage.content).toMatch(/^\(Error generating response for Terra:/);
  });
});

// ─────────────────────────────────────────────────────────────────
// B5 — Imagery Specialist prompt nudge
// ─────────────────────────────────────────────────────────────────

describe("Imagery Specialist prompt", () => {
  it("tells the expert that uploaded images arrive as native vision input", () => {
    const prompt = generateSystemPrompt(makeImageryExpert(), ["Imagery Specialist"]);
    expect(prompt).toContain("native vision input");
    expect(prompt).toContain("describe and analyze what you actually see");
  });
});

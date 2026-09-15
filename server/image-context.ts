/**
 * Image context collection for vision-capable experts.
 *
 * Uploaded images live on disk (extensionless hex names under uploads/) with
 * their mimetype in the files.fileType column. This module turns the most
 * recent image/* rows into OpenAI-style `image_url` content parts with
 * base64 data URLs, so experts receive the picture itself — not a placeholder.
 *
 * Hard limits (SPEC_CALENDAR_AND_VISION.md §B2):
 *   - at most 2 image parts per expert turn
 *   - each image capped at 5 MB raw on disk (base64 inflates ~4/3)
 *
 * Unreadable, missing, or oversize files are skipped and reported — never thrown.
 */
import path from "path";
import { stat, readFile } from "node:fs/promises";
import type { File, Message } from "@shared/schema";

export const MAX_IMAGE_PARTS = 2;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB raw bytes

/** OpenAI chat-completions multimodal content part carrying an image. */
export interface ImagePart {
  type: "image_url";
  image_url: { url: string }; // data:<mime>;base64,<...>
}

export interface ImagePartResult {
  parts: ImagePart[];
  /** Filenames of image/* files that could not be delivered (missing/unreadable/oversize). */
  skipped: string[];
  /**
   * Filenames of user-uploaded images already analyzed earlier in the
   * conversation (F2 analyze-image-once): delivered as a text note instead of
   * base64, and never counted against the `limit`.
   */
  alreadyAnalyzed: string[];
}

/** Sort helper: image files, most recently uploaded first (missing timestamps count as oldest). */
function mostRecentFirst(a: File, b: File): number {
  const ta = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
  const tb = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
  return tb - ta;
}

export function isImageFile(file: File): boolean {
  return Boolean(file.fileType && file.fileType.startsWith("image/"));
}

/**
 * User-uploaded files are marked `uploadedBy: "user"` by the upload route
 * (server/routes.ts). AI-generated files are "ai" (generate-file route) or
 * "Expert: <name>" (File-Creator) — those always keep full vision delivery.
 */
export function isUserUpload(file: File): boolean {
  return file.uploadedBy === "user";
}

/**
 * One-line text note replacing the base64 payload of an image that was already
 * analyzed earlier in the conversation (F2 analyze-image-once).
 */
export function analyzedImageNote(filename: string): string {
  return `[Image "${filename}" — analyzed earlier in this conversation]`;
}

/**
 * Build the "already analyzed" predicate from conversation history (F2).
 * A user-uploaded image counts as analyzed once ANY assistant message exists
 * with a timestamp after the file's upload — i.e. some expert turn happened
 * after the image arrived, so the image has already been seen by the panel.
 * Expert-generated files are never "already analyzed" so a freshly generated
 * image is never invisible.
 */
export function makeAnalyzedBeforePredicate(
  history: Pick<Message, "role" | "timestamp">[]
): (file: File) => boolean {
  const assistantTimes = history
    .filter((m) => m.role === "assistant" && m.timestamp)
    .map((m) => new Date(m.timestamp as Date).getTime());
  return (file: File) => {
    if (!isUserUpload(file) || !file.uploadedAt) return false;
    const uploadedAt = new Date(file.uploadedAt).getTime();
    return assistantTimes.some((t) => t > uploadedAt);
  };
}

/**
 * Collect up to `limit` image parts from the conversation's files, most
 * recent first. Disk paths are resolved with the same cwd-join convention
 * as readFileContent in server/ai.ts. Never throws: problem files are
 * returned in `skipped` instead.
 *
 * `analyzedBefore` (F2 analyze-image-once): when provided, files for which it
 * returns true are excluded from base64 embedding (returned in
 * `alreadyAnalyzed` instead) and do not consume the `limit` budget — the cap
 * applies only to newly-embedded images.
 */
export async function collectImageParts(
  files: File[],
  limit: number = MAX_IMAGE_PARTS,
  analyzedBefore?: (file: File) => boolean
): Promise<ImagePartResult> {
  const parts: ImagePart[] = [];
  const skipped: string[] = [];
  const alreadyAnalyzed: string[] = [];

  const images = files.filter(isImageFile).sort(mostRecentFirst);

  for (const file of images) {
    if (analyzedBefore?.(file)) {
      alreadyAnalyzed.push(file.filename);
      continue;
    }
    if (parts.length >= limit) break;
    try {
      const relativePath = file.fileUrl.startsWith("/")
        ? file.fileUrl.substring(1)
        : file.fileUrl;
      // Same convention as readFileContent (server/ai.ts): fileUrl is a
      // root-relative path like /uploads/<hex>, resolved against cwd.
      const filePath = path.join(process.cwd(), relativePath);

      const stats = await stat(filePath);
      if (stats.size > MAX_IMAGE_BYTES) {
        console.warn(
          `collectImageParts: skipping ${file.filename} — ${stats.size} bytes exceeds the ${MAX_IMAGE_BYTES} byte vision limit`
        );
        skipped.push(file.filename);
        continue;
      }

      const buffer = await readFile(filePath);
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${file.fileType};base64,${buffer.toString("base64")}`,
        },
      });
    } catch (error) {
      console.warn(
        `collectImageParts: skipping ${file.filename}:`,
        error instanceof Error ? error.message : String(error)
      );
      skipped.push(file.filename);
    }
  }

  return { parts, skipped, alreadyAnalyzed };
}

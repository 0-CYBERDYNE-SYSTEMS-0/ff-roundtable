import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16; // bytes
const AUTH_TAG_LENGTH = 16; // bytes
const KEY_LENGTH = 32; // bytes (256 bits)
const SALT_LENGTH = 16; // bytes

/**
 * Derive a 32-byte key from the provided encryption key string.
 * Uses scrypt with a random salt for key derivation.
 * The salt is prepended to the encrypted output so it can be reused for decryption.
 */
function deriveKey(keyMaterial: string, salt: Buffer): Buffer {
  return scryptSync(keyMaterial, salt, KEY_LENGTH);
}

/**
 * Validate that the encryption key material can produce a 32-byte key.
 * Accepts base64-encoded keys (44 chars with padding) or hex keys (64 chars).
 */
function validateEncryptionKey(keyMaterial: string): void {
  // Try base64 decode
  if (keyMaterial.length === 44) {
    const decoded = Buffer.from(keyMaterial, "base64");
    if (decoded.length === KEY_LENGTH) return;
  }

  // Try hex decode
  if (keyMaterial.length === 64) {
    const decoded = Buffer.from(keyMaterial, "hex");
    if (decoded.length === KEY_LENGTH) return;
  }

  throw new Error(
    `Invalid ENCRYPTION_KEY: must be exactly ${KEY_LENGTH} bytes. ` +
      `Provide a base64-encoded string (44 chars) or hex string (64 chars). ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
  );
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns base64-encoded "salt:iv:ciphertext:tag".
 *
 * Never log the plaintext key or the returned ciphertext in production.
 */
export function encryptApiKey(plaintext: string, encryptionKey: string): string {
  if (!plaintext) throw new Error("Plaintext cannot be empty");
  validateEncryptionKey(encryptionKey);

  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(encryptionKey, salt);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Format: salt:iv:ciphertext:tag — all base64
  const payload = Buffer.concat([salt, iv, encrypted, authTag]);
  return payload.toString("base64");
}

/**
 * Decrypt a base64-encoded "salt:iv:ciphertext:tag" string.
 * Returns the original plaintext.
 *
 * Never log the decrypted plaintext in production.
 */
export function decryptApiKey(encrypted: string, encryptionKey: string): string {
  if (!encrypted) throw new Error("Encrypted data cannot be empty");
  validateEncryptionKey(encryptionKey);

  const payload = Buffer.from(encrypted, "base64");

  // Minimum length: salt + iv + 1 byte ciphertext + tag
  const minLength = SALT_LENGTH + IV_LENGTH + 1 + AUTH_TAG_LENGTH;
  if (payload.length < minLength) {
    throw new Error("Invalid encrypted data: too short");
  }

  const salt = payload.subarray(0, SALT_LENGTH);
  const iv = payload.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = payload.subarray(payload.length - AUTH_TAG_LENGTH);
  const ciphertext = payload.subarray(SALT_LENGTH + IV_LENGTH, payload.length - AUTH_TAG_LENGTH);

  const key = deriveKey(encryptionKey, salt);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Mask an API key for display/logging.
 * Returns "sk-or-...last4" or "sk-...last4".
 */
export function maskApiKey(key: string): string {
  if (!key || key.length < 8) return "***";
  const prefix = key.startsWith("sk-or-") ? "sk-or-" : key.startsWith("sk-") ? "sk-" : "";
  const visible = key.slice(-4);
  return `${prefix}...${visible}`;
}

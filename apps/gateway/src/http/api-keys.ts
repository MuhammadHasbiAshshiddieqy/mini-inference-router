import { createHash, randomBytes } from "node:crypto";

// Tenant API keys are high-entropy random strings, so a fast SHA-256 lookup is the right tool (docs/11 §2).
// Only the hash and an 8-char prefix are stored; the key is shown once when generated.

const KEY_PREFIX = "mir_";
export const MIN_API_KEY_LENGTH = 20;

export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(24).toString("base64url");
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

// Safe to log and show in the UI.
export function apiKeyPrefix(key: string): string {
  return key.slice(0, 8);
}

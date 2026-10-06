import { describe, expect, it } from "vitest";
import { MIN_API_KEY_LENGTH, apiKeyPrefix, generateApiKey, hashApiKey } from "./api-keys.ts";

describe("api keys", () => {
  it("generates distinct, prefixed, URL-safe keys", () => {
    const keys = Array.from({ length: 50 }, generateApiKey);
    expect(new Set(keys).size).toBe(50);
    for (const key of keys) {
      expect(key).toMatch(/^mir_[A-Za-z0-9_-]{32}$/);
      expect(key.length).toBeGreaterThanOrEqual(MIN_API_KEY_LENGTH);
    }
  });

  it("hashes with SHA-256 hex (stable, never the key itself)", () => {
    expect(hashApiKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const key = generateApiKey();
    expect(hashApiKey(key)).not.toContain(key);
  });

  it("exposes only an 8-char prefix", () => {
    expect(apiKeyPrefix("mir_abcdefghijkl")).toBe("mir_abcd");
  });
});

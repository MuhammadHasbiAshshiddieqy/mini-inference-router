import { describe, expect, it } from "vitest";
import { EnvError, embeddingModelFor, loadEnv } from "./env.ts";

const base = { DATABASE_URL: "postgres://postgres:postgres@localhost:5432/router", ADMIN_API_KEY: "local-admin" };

describe("loadEnv", () => {
  it("applies documented defaults for the local profile", () => {
    const env = loadEnv(base);
    expect(env.PROFILE).toBe("local");
    expect(env.PORT).toBe(8787);
    expect(env.OLLAMA_THINK).toBe(false);
    expect(env.RETRIEVAL_LEXICAL_FALLBACK).toBe(true);
    expect(env.CORS_ORIGINS).toEqual(["http://localhost:5173"]);
    expect(env.CONFIDENCE_T_OOS).toBeUndefined();
    expect(embeddingModelFor(env)).toBe("nomic-embed-text");
  });

  it("treats empty values as unset (as written in .env.example)", () => {
    const env = loadEnv({ ...base, GEMINI_API_KEY: "", CONFIDENCE_T_OOS: "  ", PORT: "" });
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.CONFIDENCE_T_OOS).toBeUndefined();
    expect(env.PORT).toBe(8787);
  });

  it("requires GEMINI_API_KEY for profiles that use Gemini", () => {
    expect(() => loadEnv({ ...base, PROFILE: "cloud" })).toThrow(/GEMINI_API_KEY: required when PROFILE=cloud/);
    expect(() => loadEnv({ ...base, PROFILE: "hybrid" })).toThrow(EnvError);
    expect(() => loadEnv({ ...base, PROFILE: "staging" })).toThrow(/PROFILE/);
    const env = loadEnv({ ...base, PROFILE: "cloud", GEMINI_API_KEY: "k" });
    expect(embeddingModelFor(env)).toBe("gemini-embedding-001");
  });

  it("lists every invalid variable in one readable message", () => {
    let message = "";
    try {
      loadEnv({ PROFILE: "cloud", PORT: "abc", OLLAMA_THINK: "yes" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    for (const key of ["PORT", "DATABASE_URL", "ADMIN_API_KEY", "OLLAMA_THINK", "GEMINI_API_KEY"]) {
      expect(message).toContain(`- ${key}:`);
    }
  });

  it("parses lists, booleans and thresholds", () => {
    const env = loadEnv({
      ...base,
      CORS_ORIGINS: "http://a.test, http://b.test",
      OLLAMA_SUPPORTS_TOOLS: "false",
      CONFIDENCE_T_OOS: "0.62",
    });
    expect(env.CORS_ORIGINS).toEqual(["http://a.test", "http://b.test"]);
    expect(env.OLLAMA_SUPPORTS_TOOLS).toBe(false);
    expect(env.CONFIDENCE_T_OOS).toBe(0.62);
  });

  it("rejects a non-postgres DATABASE_URL and an out-of-range threshold", () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: "mysql://x@localhost/db" })).toThrow(/DATABASE_URL/);
    expect(() => loadEnv({ ...base, CONFIDENCE_T_HIGH: "1.5" })).toThrow(/CONFIDENCE_T_HIGH/);
  });
});

import { describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.ts";
import { backendSpecs, geminiSupportsTools } from "../config/profiles.ts";
import { AppError } from "../http/errors.ts";
import { plan } from "./plan.ts";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/x", ADMIN_API_KEY: "test-admin", GEMINI_API_KEY: "k" };
const cloud = backendSpecs(loadEnv({ ...base, PROFILE: "cloud" }));
const local = backendSpecs(loadEnv({ ...base, PROFILE: "local" }));
const ALL = ["gemini-3.5-flash", "gemini-3-flash", "ollama", "mock"] as const;

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof AppError ? `${err.httpStatus} ${err.code}` : String(err);
  }
  return undefined;
}

describe("profiles", () => {
  it("cloud and local profiles list backends in priority order", () => {
    expect(cloud.map((b) => [b.id, b.model, b.priority])).toEqual([
      ["gemini-3.5-flash", "gemini-3.5-flash", 0],
      ["gemini-3-flash", "gemini-3-flash-preview", 1],
      ["mock", "mock", 2],
    ]);
    expect(local.map((b) => b.id)).toEqual(["ollama", "mock"]);
  });

  it("allows tools only on Gemini >= 3 (owner rule), whatever model the env points to", () => {
    expect(geminiSupportsTools("gemini-3.5-flash")).toBe(true);
    expect(geminiSupportsTools("gemini-3-flash-preview")).toBe(true);
    expect(geminiSupportsTools("gemini-2.5-flash")).toBe(false);
    const downgraded = backendSpecs(loadEnv({ ...base, PROFILE: "cloud", GEMINI_FALLBACK_MODEL: "gemini-2.5-flash" }));
    expect(downgraded.find((b) => b.id === "gemini-3-flash")?.supportsTools).toBe(false);
  });
});

describe("plan", () => {
  it("keeps every allowed backend in priority order and records no exclusions", () => {
    const result = plan({ profileBackends: [...cloud].reverse(), allowedBackends: ALL, hasTools: false });
    expect(result.candidates.map((b) => b.id)).toEqual(["gemini-3.5-flash", "gemini-3-flash", "mock"]);
    expect(result.decisions).toEqual([]);
  });

  it("rule 1: tenant policy removes disallowed backends and says why (globex)", () => {
    const result = plan({ profileBackends: cloud, allowedBackends: ["gemini-3-flash", "mock"], hasTools: false });
    expect(result.candidates.map((b) => b.id)).toEqual(["gemini-3-flash", "mock"]);
    expect(result.decisions).toEqual(["excluded gemini-3.5-flash: not in tenant allowed_backends"]);
  });

  it("rule 1: nothing allowed → 403 no_allowed_backend", () => {
    expect(
      errorCode(() => plan({ profileBackends: local, allowedBackends: ["gemini-3-flash"], hasTools: false })),
    ).toBe("403 no_allowed_backend");
  });

  it("rule 2: tools keep only tool-capable backends (Gemini 3+, Ollama with tools), never the mock", () => {
    const result = plan({ profileBackends: cloud, allowedBackends: ALL, hasTools: true });
    expect(result.candidates.map((b) => b.id)).toEqual(["gemini-3.5-flash", "gemini-3-flash"]);
    expect(result.decisions).toEqual(["excluded mock: does not support tools"]);
    expect(plan({ profileBackends: local, allowedBackends: ALL, hasTools: true }).candidates.map((b) => b.id)).toEqual([
      "ollama",
    ]);
  });

  it("rule 2: tools requested but no allowed backend supports them → 422 tools_unsupported", () => {
    expect(errorCode(() => plan({ profileBackends: cloud, allowedBackends: ["mock"], hasTools: true }))).toBe(
      "422 tools_unsupported",
    );
    const noOllamaTools = backendSpecs(loadEnv({ ...base, PROFILE: "local", OLLAMA_SUPPORTS_TOOLS: "false" }));
    expect(errorCode(() => plan({ profileBackends: noOllamaTools, allowedBackends: ALL, hasTools: true }))).toBe(
      "422 tools_unsupported",
    );
  });
});

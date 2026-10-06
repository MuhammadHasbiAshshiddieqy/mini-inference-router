import type { BackendId } from "@mir/shared";
import type { Env } from "../config/env.ts";
import { backendSpecs } from "../config/profiles.ts";
import { createGeminiBackend } from "./gemini.ts";
import { createMockBackend } from "./mock.ts";
import { createOllamaBackend } from "./ollama.ts";
import type { Backend } from "./types.ts";

export type BackendRegistry = {
  backends: Backend[]; // active profile, priority order
  get(id: BackendId): Backend | undefined;
};

// Builds the active profile's backends from env (docs/04 §3).
export function createBackendRegistry(env: Env): BackendRegistry {
  const backends = backendSpecs(env).map((spec): Backend => {
    switch (spec.kind) {
      case "gemini":
        if (!env.GEMINI_API_KEY) throw new Error(`GEMINI_API_KEY is required for backend ${spec.id}`);
        return createGeminiBackend(spec, { apiKey: env.GEMINI_API_KEY, thinkingLevel: env.GEMINI_THINKING_LEVEL });
      case "ollama":
        return createOllamaBackend(spec, { host: env.OLLAMA_URL, think: env.OLLAMA_THINK });
      case "mock":
        return createMockBackend(spec, { latencyMs: env.MOCK_LATENCY_MS, failRate: env.MOCK_FAIL_RATE });
    }
  });
  return { backends, get: (id) => backends.find((b) => b.spec.id === id) };
}

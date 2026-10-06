import { Hono } from "hono";
import type { BackendRegistry } from "../backends/registry.ts";
import { probeOllama, type OllamaStatus } from "../backends/ollama-health.ts";
import { embeddingModelFor, type Env } from "../config/env.ts";
import type { AppEnv } from "../http/types.ts";

export type OllamaProbe = (host: string, models: string[]) => Promise<OllamaStatus>;

// Liveness + config fingerprint (docs/03 §3). No secrets, no LLM calls: Ollama is probed with GET /api/tags,
// Gemini only reports whether a key is configured. The eval runner stores this fingerprint with its results.
// The gateway stays "ok" when a backend is down: the router falls back and the attempt rows say why.
// KB and pg_trgm checks are added with the support assistant (docs/05 §2.6).
export function healthRoutes(env: Env, registry: BackendRegistry, probe: OllamaProbe = probeOllama) {
  return new Hono<AppEnv>().get("/healthz", async (c) => {
    const usesOllama = registry.backends.some((b) => b.spec.kind === "ollama");
    const ollama = usesOllama
      ? await probe(env.OLLAMA_URL, [env.OLLAMA_CHAT_MODEL, env.OLLAMA_EMBED_MODEL])
      : undefined;
    return c.json({
      status: "ok",
      profile: env.PROFILE,
      embedding_model: embeddingModelFor(env),
      retrieval_mode: env.RETRIEVAL_MODE,
      thinking_level: registry.backends.some((b) => b.spec.kind === "gemini") ? env.GEMINI_THINKING_LEVEL : null,
      backends: registry.backends.map(({ spec }) => ({
        id: spec.id,
        kind: spec.kind,
        model: spec.model,
        priority: spec.priority,
        supports_tools: spec.supportsTools,
        ttft_timeout_ms: spec.ttftTimeoutMs,
        total_timeout_ms: spec.totalTimeoutMs,
        price_per_1m: { input: spec.price.inputPer1M, output: spec.price.outputPer1M },
        ...(spec.kind === "gemini" ? { configured: Boolean(env.GEMINI_API_KEY) } : {}),
      })),
      ...(ollama ? { ollama } : {}),
    });
  });
}

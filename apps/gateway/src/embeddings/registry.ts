import { embeddingModelFor, type Env } from "../config/env.ts";
import { createGeminiEmbedder } from "./gemini.ts";
import { createOllamaEmbedder } from "./ollama.ts";
import type { Embedder } from "./types.ts";

// Query embedder for the active profile (docs/02 §7): Gemini embedding in cloud/hybrid, nomic-embed-text locally.
// It must be the same model that embedded the KB rows it is compared with (kb_entries.embedding_model).
export function createQueryEmbedder(env: Env): Embedder {
  const model = embeddingModelFor(env);
  if (env.PROFILE === "local") {
    return createOllamaEmbedder({ host: env.OLLAMA_URL, model, timeoutMs: env.EMBED_TIMEOUT_MS });
  }
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required for the Gemini embedder");
  return createGeminiEmbedder({ apiKey: env.GEMINI_API_KEY, model, timeoutMs: env.EMBED_TIMEOUT_MS });
}

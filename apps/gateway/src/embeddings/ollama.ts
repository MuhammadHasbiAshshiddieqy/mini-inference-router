import { Ollama } from "ollama";
import { EmbeddingError, checkVectors, withTimeout, type Embedder } from "./types.ts";

export type OllamaEmbedderOptions = {
  host: string;
  model: string; // e.g. nomic-embed-text (768-dim)
  timeoutMs: number;
  fetchImpl?: typeof fetch; // injectable for tests
};

// nomic-embed-text expects task prefixes: `search_document: ` for KB entries, `search_query: ` for queries.
// source: https://ollama.com/library/nomic-embed-text, checked 2026-10-06 (768 dims verified locally).
export function createOllamaEmbedder({ host, model, timeoutMs, fetchImpl = fetch }: OllamaEmbedderOptions): Embedder {
  async function embed(input: string[], signal?: AbortSignal): Promise<number[][]> {
    const combined = withTimeout(timeoutMs, signal);
    // A client per call: the abort signal is bound to this call's fetch only.
    const client = new Ollama({ host, fetch: (url, init) => fetchImpl(url, { ...init, signal: combined }) });
    let embeddings: unknown;
    try {
      ({ embeddings } = await client.embed({ model, input }));
    } catch (err) {
      const reason = combined.aborted ? "timed out or aborted" : err instanceof Error ? err.message : String(err);
      throw new EmbeddingError(`ollama ${model}: ${reason}`, { cause: err });
    }
    return checkVectors(embeddings, input.length, model);
  }

  return {
    provider: "ollama",
    model,
    embedDocuments: (texts, signal) =>
      embed(
        texts.map((t) => `search_document: ${t}`),
        signal,
      ),
    embedQueries: (texts, signal) =>
      embed(
        texts.map((t) => `search_query: ${t}`),
        signal,
      ),
    embedQuery: async (text, signal) => {
      const [vector] = await embed([`search_query: ${text}`], signal);
      if (!vector) throw new EmbeddingError(`ollama ${model}: empty response`);
      return vector;
    },
  };
}

import { GoogleGenAI, type EmbedContentParameters, type EmbedContentResponse } from "@google/genai";
import { EMBEDDING_DIMS, EmbeddingError, checkVectors, withTimeout, type Embedder } from "./types.ts";

type EmbedFn = (params: EmbedContentParameters) => Promise<EmbedContentResponse>;

export type GeminiEmbedderOptions = {
  apiKey: string;
  model: string; // GEMINI_EMBED_MODEL
  timeoutMs: number;
  embedContent?: EmbedFn; // injectable for tests
};

// `ai.models.embedContent({ model, contents, config: { taskType, outputDimensionality, abortSignal } })`
// returns `embeddings[].values`. Vectors below the default dimension must be L2-normalized by the caller.
// source: https://googleapis.github.io/js-genai/ (EmbedContentConfig) and https://ai.google.dev/gemini-api/docs/embeddings,
// checked 2026-10-06. abortSignal is client-side only: the request may still be billed.
export function createGeminiEmbedder({ apiKey, model, timeoutMs, embedContent }: GeminiEmbedderOptions): Embedder {
  const call: EmbedFn = embedContent ?? ((params) => new GoogleGenAI({ apiKey }).models.embedContent(params));

  async function embed(
    texts: string[],
    taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
    signal?: AbortSignal,
  ): Promise<number[][]> {
    const abortSignal = withTimeout(timeoutMs, signal);
    let response: EmbedContentResponse;
    try {
      response = await call({
        model,
        contents: texts,
        config: { taskType, outputDimensionality: EMBEDDING_DIMS, abortSignal },
      });
    } catch (err) {
      const reason = abortSignal.aborted ? "timed out or aborted" : err instanceof Error ? err.message : String(err);
      throw new EmbeddingError(`gemini ${model}: ${reason}`, { cause: err });
    }
    return checkVectors(
      response.embeddings?.map((e) => e.values),
      texts.length,
      model,
    );
  }

  return {
    provider: "gemini",
    model,
    embedDocuments: (texts, signal) => embed(texts, "RETRIEVAL_DOCUMENT", signal),
    embedQuery: async (text, signal) => {
      const [vector] = await embed([text], "RETRIEVAL_QUERY", signal);
      if (!vector) throw new EmbeddingError(`gemini ${model}: empty response`);
      return vector;
    },
  };
}

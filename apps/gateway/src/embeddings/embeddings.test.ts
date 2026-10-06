import type { EmbedContentParameters, EmbedContentResponse } from "@google/genai";
import { describe, expect, it } from "vitest";
import { createGeminiEmbedder } from "./gemini.ts";
import { createOllamaEmbedder } from "./ollama.ts";
import { EMBEDDING_DIMS, EmbeddingError, checkVectors, l2Normalize } from "./types.ts";

const vec = (seed: number) => Array.from({ length: EMBEDDING_DIMS }, (_, i) => ((i % 7) + seed) / 10);
const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

describe("vector checks", () => {
  it("l2Normalize returns a unit vector and rejects zero vectors", () => {
    expect(norm(l2Normalize([3, 4]))).toBeCloseTo(1, 12);
    expect(() => l2Normalize([0, 0])).toThrow(EmbeddingError);
  });

  it("checkVectors rejects wrong counts, wrong dimensions and non-numbers", () => {
    expect(() => checkVectors([vec(1)], 2, "m")).toThrow(/expected 2 embeddings, got 1/);
    expect(() => checkVectors([[1, 2, 3]], 1, "m")).toThrow(/768-dim/);
    expect(() => checkVectors([vec(1).map(String)], 1, "m")).toThrow(EmbeddingError);
    expect(() => checkVectors(undefined, 1, "m")).toThrow(EmbeddingError);
  });
});

describe("ollama embedder", () => {
  function fakeFetch(handler: (body: { model: string; input: string[] }) => Response) {
    const calls: { url: string; body: { model: string; input: string[] }; signal: AbortSignal | null }[] = [];
    const impl: typeof fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
      calls.push({ url: String(url), body, signal: init?.signal ?? null });
      return handler(body);
    };
    return { impl, calls };
  }

  it("adds nomic task prefixes and returns normalized vectors", async () => {
    const { impl, calls } = fakeFetch(
      (body) => new Response(JSON.stringify({ embeddings: body.input.map((_, i) => vec(i + 1)) })),
    );
    const embedder = createOllamaEmbedder({
      host: "http://ollama.test:11434",
      model: "nomic-embed-text",
      timeoutMs: 1000,
      fetchImpl: impl,
    });

    const docs = await embedder.embedDocuments(["cancel order", "track refund"]);
    const query = await embedder.embedQuery("where is my refund");

    expect(calls[0]?.body.input).toEqual(["search_document: cancel order", "search_document: track refund"]);
    expect(calls[1]?.body.input).toEqual(["search_query: where is my refund"]);
    expect(calls[0]?.url).toBe("http://ollama.test:11434/api/embed");
    expect(calls[0]?.signal).not.toBeNull();
    expect(docs).toHaveLength(2);
    for (const v of [...docs, query]) expect(norm(v)).toBeCloseTo(1, 10);
  });

  it("wraps provider errors and timeouts in EmbeddingError", async () => {
    const failing = createOllamaEmbedder({
      host: "http://ollama.test:11434",
      model: "nomic-embed-text",
      timeoutMs: 1000,
      fetchImpl: async () => new Response(JSON.stringify({ error: "model not found" }), { status: 404 }),
    });
    await expect(failing.embedQuery("x")).rejects.toThrow(EmbeddingError);

    const hanging = createOllamaEmbedder({
      host: "http://ollama.test:11434",
      model: "nomic-embed-text",
      timeoutMs: 20,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        ),
    });
    await expect(hanging.embedQuery("x")).rejects.toThrow(/timed out or aborted/);
  });
});

describe("gemini embedder", () => {
  it("uses retrieval task types, 768 output dims and an abort signal", async () => {
    const calls: EmbedContentParameters[] = [];
    const embedContent = async (params: EmbedContentParameters): Promise<EmbedContentResponse> => {
      calls.push(params);
      const n = Array.isArray(params.contents) ? params.contents.length : 1;
      return { embeddings: Array.from({ length: n }, (_, i) => ({ values: vec(i + 1) })) };
    };
    const embedder = createGeminiEmbedder({
      apiKey: "k",
      model: "gemini-embedding-001",
      timeoutMs: 1000,
      embedContent,
    });

    const docs = await embedder.embedDocuments(["a", "b", "c"]);
    await embedder.embedQuery("q");

    expect(docs).toHaveLength(3);
    expect(calls[0]?.contents).toEqual(["a", "b", "c"]);
    expect(calls[0]?.config?.taskType).toBe("RETRIEVAL_DOCUMENT");
    expect(calls[0]?.config?.outputDimensionality).toBe(768);
    expect(calls[0]?.config?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(calls[1]?.config?.taskType).toBe("RETRIEVAL_QUERY");
    for (const v of docs) expect(norm(v)).toBeCloseTo(1, 10);
  });

  it("fails loudly when the provider returns fewer vectors than texts", async () => {
    const embedder = createGeminiEmbedder({
      apiKey: "k",
      model: "gemini-embedding-001",
      timeoutMs: 1000,
      embedContent: async () => ({ embeddings: [{ values: vec(1) }] }),
    });
    await expect(embedder.embedDocuments(["a", "b"])).rejects.toThrow(/expected 2 embeddings, got 1/);
  });

  it("wraps SDK errors in EmbeddingError", async () => {
    const embedder = createGeminiEmbedder({
      apiKey: "k",
      model: "gemini-embedding-001",
      timeoutMs: 1000,
      embedContent: async () => {
        throw new Error("429 RESOURCE_EXHAUSTED");
      },
    });
    await expect(embedder.embedQuery("q")).rejects.toThrow(/gemini gemini-embedding-001: 429 RESOURCE_EXHAUSTED/);
  });
});

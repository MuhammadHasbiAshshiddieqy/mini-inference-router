// Embedding adapters (docs/02 §7). Both providers return L2-normalized 768-dim vectors; vectors from
// different models are never compared (kb_entries is keyed by embedding_model).

export const EMBEDDING_DIMS = 768;

export interface Embedder {
  readonly provider: "gemini" | "ollama";
  readonly model: string;
  // KB entries (instructions). Returns one vector per text, in order.
  embedDocuments(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  // A customer message at request time.
  embedQuery(text: string, signal?: AbortSignal): Promise<number[]>;
}

export class EmbeddingError extends Error {
  override name = "EmbeddingError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export function l2Normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new EmbeddingError("cannot normalize a zero or non-finite vector");
  return vector.map((x) => x / norm);
}

// Checks provider output before it reaches the database: right count, right dimension, finite numbers.
export function checkVectors(vectors: unknown, expectedCount: number, model: string): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new EmbeddingError(
      `${model}: expected ${expectedCount} embeddings, got ${Array.isArray(vectors) ? vectors.length : typeof vectors}`,
    );
  }
  return vectors.map((v: unknown, i) => {
    if (!Array.isArray(v) || v.length !== EMBEDDING_DIMS || !v.every((x) => typeof x === "number")) {
      throw new EmbeddingError(`${model}: embedding ${i} is not a ${EMBEDDING_DIMS}-dim numeric vector`);
    }
    return l2Normalize(v as number[]);
  });
}

// Combines the caller's signal (client abort) with a per-call timeout.
export function withTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

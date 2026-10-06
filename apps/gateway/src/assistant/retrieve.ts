import { IntentSchema, normalize, type RetrievalMode, type RetrievedEntry } from "@mir/shared";
import type { Logger } from "pino";
import type { Embedder } from "../embeddings/types.ts";
import { AppError } from "../http/errors.ts";
import type { Queryable } from "../quota/quota.ts";
import { retrievalSignals, type RetrievalSignals } from "./intent.ts";

// Retrieval over the KB slice (docs/05 §2). Three modes:
//   dense            pgvector cosine top-k
//   hybrid           dense top-N and pg_trgm top-N fused with RRF (one SQL round-trip), top-k
//   lexical_fallback trigram top-k, entered automatically when the query embedding fails (after one retry)
// Ranking ≠ gating: whatever orders the entries, the gate and the votes use dense cosine (trigram only in
// the fallback). In hybrid mode the TRUE dense top-1 is returned separately: the dense rank-1 entry is not
// guaranteed to survive RRF into the fused top-k when other entries rank well in both lists.

export const RESPONSE_PREVIEW_CHARS = 200;

export type RetrievedRow = RetrievedEntry & { response: string }; // full response, for the prompt

export type Retrieval = {
  mode: RetrievalMode;
  entries: RetrievedRow[];
  signals: RetrievalSignals;
  embeddingError?: string;
};

export type RetrieveOptions = {
  db: Queryable;
  embedder: Embedder;
  embeddingModel: string; // rows are filtered by this; vector spaces are never mixed
  query: string;
  mode: "dense" | "hybrid";
  topK: number;
  candidates: number; // per-retriever depth before RRF
  rrfK: number;
  lexicalFallback: boolean;
  forceEmbeddingFail?: boolean; // debug: simulate an embedding outage
  signal?: AbortSignal;
  logger: Logger;
};

type Row = {
  id: string;
  intent: string;
  instruction: string;
  response: string;
  dense_sim: number | null;
  trgm_sim: number | null;
  rrf: number | null;
  dense_rank: string | null;
  lex_rank: string | null;
  dense_top1?: number | null;
};

const vectorLiteral = (v: number[]) => `[${v.join(",")}]`;

export async function denseSearch(db: Queryable, embedding: number[], model: string, k: number): Promise<Row[]> {
  const { rows } = await db.query<Row>(
    `SELECT id, intent, instruction, response, 1 - (embedding <=> $1::vector) AS dense_sim, NULL::real AS trgm_sim,
            NULL::real AS rrf, row_number() OVER (ORDER BY embedding <=> $1::vector) AS dense_rank, NULL::bigint AS lex_rank
     FROM kb_entries WHERE embedding_model = $2
     ORDER BY embedding <=> $1::vector, id LIMIT $3`,
    [vectorLiteral(embedding), model, k],
  );
  return rows;
}

export async function hybridSearch(
  db: Queryable,
  embedding: number[],
  model: string,
  normQuery: string,
  k: number,
  depth: number,
  rrfK: number,
): Promise<Row[]> {
  const { rows } = await db.query<Row>(
    `WITH dense AS (
       SELECT id, row_number() OVER (ORDER BY embedding <=> $1::vector, id) AS r, 1 - (embedding <=> $1::vector) AS sim
       FROM kb_entries WHERE embedding_model = $2
       ORDER BY embedding <=> $1::vector, id LIMIT $6
     ), lex AS (
       SELECT id, row_number() OVER (ORDER BY similarity(instruction_norm, $3::text) DESC, id) AS r
       FROM kb_entries WHERE embedding_model = $2
       ORDER BY similarity(instruction_norm, $3::text) DESC, id LIMIT $6
     ), fused AS (
       SELECT id, COALESCE(1.0 / ($4 + d.r), 0) + COALESCE(1.0 / ($4 + l.r), 0) AS rrf, d.r AS dense_rank, l.r AS lex_rank
       FROM dense d FULL OUTER JOIN lex l USING (id)
     )
     SELECT k.id, k.intent, k.instruction, k.response, f.rrf::real AS rrf, f.dense_rank, f.lex_rank,
            1 - (k.embedding <=> $1::vector) AS dense_sim,
            similarity(k.instruction_norm, $3::text) AS trgm_sim,
            (SELECT max(sim) FROM dense) AS dense_top1
     FROM fused f JOIN kb_entries k ON k.id = f.id AND k.embedding_model = $2
     ORDER BY f.rrf DESC, f.dense_rank NULLS LAST, k.id LIMIT $5`,
    [vectorLiteral(embedding), model, normQuery, rrfK, k, depth],
  );
  return rows;
}

export async function lexicalSearch(db: Queryable, model: string, normQuery: string, k: number): Promise<Row[]> {
  const { rows } = await db.query<Row>(
    `SELECT id, intent, instruction, response, NULL::real AS dense_sim, similarity(instruction_norm, $2::text) AS trgm_sim,
            NULL::real AS rrf, NULL::bigint AS dense_rank,
            row_number() OVER (ORDER BY similarity(instruction_norm, $2::text) DESC, id) AS lex_rank
     FROM kb_entries WHERE embedding_model = $1
     ORDER BY similarity(instruction_norm, $2::text) DESC, id LIMIT $3`,
    [model, normQuery, k],
  );
  return rows;
}

function toEntry(row: Row): RetrievedRow {
  const num = (v: number | string | null) => (v === null ? null : Number(v));
  return {
    id: row.id,
    intent: IntentSchema.parse(row.intent),
    dense_sim: num(row.dense_sim),
    trgm_sim: num(row.trgm_sim),
    rrf: num(row.rrf),
    dense_rank: num(row.dense_rank),
    lex_rank: num(row.lex_rank),
    instruction: row.instruction,
    response_preview: row.response.slice(0, RESPONSE_PREVIEW_CHARS),
    response: row.response,
  };
}

async function embedWithRetry(opts: RetrieveOptions): Promise<{ vector?: number[]; error?: string }> {
  if (opts.forceEmbeddingFail) return { error: "debug.force_embedding_fail" };
  let last = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return { vector: await opts.embedder.embedQuery(opts.query, opts.signal) };
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      opts.logger.warn({ attempt, error: last }, "query embedding failed");
      if (opts.signal?.aborted) break;
    }
  }
  return { error: last };
}

export async function retrieve(opts: RetrieveOptions): Promise<Retrieval> {
  const normQuery = normalize(opts.query);
  const embedded = await embedWithRetry(opts);

  if (!embedded.vector) {
    if (!opts.lexicalFallback) {
      throw new AppError("embedding_unavailable", 503, "Query embedding failed and lexical fallback is disabled", {
        error: embedded.error,
      });
    }
    const rows = await lexicalSearch(opts.db, opts.embeddingModel, normQuery, opts.topK);
    if (rows.length === 0)
      throw new AppError("assistant_unavailable", 503, `No KB rows for ${opts.embeddingModel}; run pnpm kb:embed`);
    const entries = rows.map(toEntry);
    return {
      mode: "lexical_fallback",
      entries,
      signals: retrievalSignals("lexical_fallback", entries),
      ...(embedded.error ? { embeddingError: embedded.error } : {}),
    };
  }

  const rows =
    opts.mode === "hybrid"
      ? await hybridSearch(
          opts.db,
          embedded.vector,
          opts.embeddingModel,
          normQuery,
          opts.topK,
          opts.candidates,
          opts.rrfK,
        )
      : await denseSearch(opts.db, embedded.vector, opts.embeddingModel, opts.topK);
  if (rows.length === 0)
    throw new AppError("assistant_unavailable", 503, `No KB rows for ${opts.embeddingModel}; run pnpm kb:embed`);
  const entries = rows.map(toEntry);
  const signals = retrievalSignals(opts.mode, entries);
  const denseTop1 = rows[0]?.dense_top1;
  // Gate on the true dense top-1 (see header comment), never on RRF scores.
  if (opts.mode === "hybrid" && denseTop1 != null) signals.top1Similarity = Number(denseTop1);
  return { mode: opts.mode, entries, signals };
}

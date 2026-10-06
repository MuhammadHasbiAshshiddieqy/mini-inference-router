// pnpm kb:embed -- --provider ollama|gemini [--from-cache-only] [--batch-size N] [--delay-ms N]
// Embeds data/kb.jsonl into data/embeddings/<model>.f32 (cache, committed) and upserts kb_entries (docs/02 §7).
// The cache is (re)built only when missing or stale; an interrupted build resumes where it stopped.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatasetRowSchema, normalize, type DatasetRow } from "@mir/shared";
import { z } from "zod";
import { createDb } from "../apps/gateway/src/db/client.ts";
import { createGeminiEmbedder } from "../apps/gateway/src/embeddings/gemini.ts";
import { createOllamaEmbedder } from "../apps/gateway/src/embeddings/ollama.ts";
import { EMBEDDING_DIMS, type Embedder } from "../apps/gateway/src/embeddings/types.ts";
import {
  appendVectors,
  cachePaths,
  inspectCache,
  readVectors,
  startEmpty,
  truncateToRows,
  writeMeta,
  type CachePaths,
} from "./lib/embedding-cache.ts";
import { databaseEnv, describeDatabase, fail, parseCliArgs, parseScriptEnv } from "./lib/cli.ts";

const KB_FILE = fileURLToPath(new URL("../data/kb.jsonl", import.meta.url));
const CACHE_DIR = fileURLToPath(new URL("../data/embeddings/", import.meta.url));
const BATCH_ATTEMPTS = 3;
const UPSERT_CHUNK = 100;

const args = parseCliArgs({
  provider: { type: "string" },
  "from-cache-only": { type: "boolean", default: false },
  "batch-size": { type: "string" },
  "delay-ms": { type: "string" },
});
const provider = z.enum(["ollama", "gemini"]).safeParse(args.provider);
if (!provider.success) fail("--provider must be 'ollama' or 'gemini'");

const env = parseScriptEnv({
  ...databaseEnv,
  EMBED_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  OLLAMA_URL: z.url().default("http://localhost:11434"),
  OLLAMA_EMBED_MODEL: z.string().default("nomic-embed-text"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_EMBED_MODEL: z.string().default("gemini-embedding-001"),
});

// Gemini free tier is rate-limited, so smaller batches with a pause; local Ollama can go faster.
const defaults = provider.data === "gemini" ? { batch: 50, delay: 1500 } : { batch: 64, delay: 0 };
const batchSize = Number(args["batch-size"] ?? defaults.batch);
const delayMs = Number(args["delay-ms"] ?? defaults.delay);
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) fail("--batch-size must be 1..100");
if (!Number.isInteger(delayMs) || delayMs < 0) fail("--delay-ms must be >= 0");

const model = provider.data === "gemini" ? env.GEMINI_EMBED_MODEL : env.OLLAMA_EMBED_MODEL;

function createEmbedder(): Embedder {
  if (provider.data === "ollama") {
    return createOllamaEmbedder({ host: env.OLLAMA_URL, model, timeoutMs: env.EMBED_TIMEOUT_MS });
  }
  if (!env.GEMINI_API_KEY) fail("GEMINI_API_KEY is required for --provider gemini (use the router-eval project key)");
  return createGeminiEmbedder({ apiKey: env.GEMINI_API_KEY, model, timeoutMs: env.EMBED_TIMEOUT_MS });
}

function loadKb(): { rows: DatasetRow[]; sha256: string } {
  const text = readFileSync(KB_FILE, "utf-8");
  const rows = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, i) => {
      const parsed = DatasetRowSchema.safeParse(JSON.parse(line));
      if (!parsed.success) fail(`kb.jsonl line ${i + 1}: ${parsed.error.issues[0]?.message ?? "invalid row"}`);
      return parsed.data;
    });
  return { rows, sha256: createHash("sha256").update(text).digest("hex") };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function embedWithRetry(embedder: Embedder, texts: string[]): Promise<number[][]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await embedder.embedDocuments(texts);
    } catch (err) {
      if (attempt >= BATCH_ATTEMPTS) throw err;
      const backoff = Math.max(2000, delayMs) * 2 ** (attempt - 1);
      console.warn(`  batch failed (${err instanceof Error ? err.message : String(err)}); retry in ${backoff} ms`);
      await sleep(backoff);
    }
  }
}

async function buildCache(paths: CachePaths, rows: DatasetRow[], kbSha256: string, resumeFrom: number) {
  const embedder = createEmbedder();
  if (resumeFrom === 0) startEmpty(paths);
  else truncateToRows(paths, resumeFrom, EMBEDDING_DIMS);
  const meta = { model, provider: provider.data!, dims: EMBEDDING_DIMS, kb_sha256: kbSha256 };

  const started = Date.now();
  for (let start = resumeFrom; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const vectors = await embedWithRetry(
      embedder,
      batch.map((r) => r.instruction),
    );
    appendVectors(paths, vectors, EMBEDDING_DIMS);
    const done = start + batch.length;
    writeMeta(paths, { ...meta, count: done, complete: done === rows.length });
    process.stdout.write(`\r  embedded ${done}/${rows.length}`);
    if (delayMs > 0 && done < rows.length) await sleep(delayMs);
  }
  console.log(`\n  cache built in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

async function upsert(rows: DatasetRow[], vectors: number[][]) {
  const { pool } = createDb({ databaseUrl: env.DATABASE_URL, timeoutMs: Math.max(env.DB_TIMEOUT_MS, 30_000) });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let start = 0; start < rows.length; start += UPSERT_CHUNK) {
      const chunk = rows.slice(start, start + UPSERT_CHUNK);
      const params: unknown[] = [];
      const values = chunk.map((r, i) => {
        const vector = vectors[start + i];
        if (!vector) throw new Error(`missing vector for row ${start + i}`);
        params.push(r.id, model, r.intent, r.category, r.flags, r.instruction, r.response, normalize(r.instruction));
        params.push(`[${vector.join(",")}]`);
        const base = i * 9;
        return `(${Array.from({ length: 9 }, (_, k) => `$${base + k + 1}`).join(", ")})`;
      });
      await client.query(
        `INSERT INTO kb_entries (id, embedding_model, intent, category, flags, instruction, response, instruction_norm, embedding)
         VALUES ${values.join(", ")}
         ON CONFLICT (id, embedding_model) DO UPDATE SET intent = EXCLUDED.intent, category = EXCLUDED.category,
           flags = EXCLUDED.flags, instruction = EXCLUDED.instruction, response = EXCLUDED.response,
           instruction_norm = EXCLUDED.instruction_norm, embedding = EXCLUDED.embedding`,
        params,
      );
    }
    // Rows of this model that are no longer in kb.jsonl.
    const removed = await client.query("DELETE FROM kb_entries WHERE embedding_model = $1 AND NOT (id = ANY($2))", [
      model,
      rows.map((r) => r.id),
    ]);
    await client.query("COMMIT");
    const { rows: count } = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM kb_entries WHERE embedding_model = $1",
      [model],
    );
    console.log(
      `✓ kb_entries: ${count[0]?.n} rows for ${model} in ${describeDatabase(env.DATABASE_URL)}` +
        (removed.rowCount ? ` (${removed.rowCount} stale rows removed)` : ""),
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

try {
  const { rows, sha256 } = loadKb();
  mkdirSync(CACHE_DIR, { recursive: true });
  const paths = cachePaths(CACHE_DIR, model);
  const state = inspectCache(paths, { model, dims: EMBEDDING_DIMS, count: rows.length, kbSha256: sha256 });
  console.log(
    `KB: ${rows.length} rows, model ${model} (${provider.data}), cache ${state.kind}` +
      (state.kind === "stale" ? `: ${state.reason}` : state.kind === "partial" ? ` at ${state.meta.count} rows` : ""),
  );

  if (state.kind !== "fresh") {
    if (args["from-cache-only"]) {
      fail(
        `no usable cache at ${paths.data} (${state.kind}). Run \`pnpm kb:embed -- --provider ${provider.data}\` once with the provider available, and commit data/embeddings/.`,
      );
    }
    await buildCache(paths, rows, sha256, state.kind === "partial" ? state.meta.count : 0);
  }
  await upsert(rows, readVectors(paths, rows.length, EMBEDDING_DIMS));
} catch (err) {
  fail(
    `kb:embed failed: ${err instanceof Error ? err.message : String(err)}\nRe-run the same command to resume from the cache.`,
  );
}

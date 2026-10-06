// pnpm calibrate [-- --provider ollama|gemini]
// Computes refusal thresholds from the DEV split only (docs/05 §7) and writes data/thresholds.json:
//   T_oos      largest dense threshold keeping in-domain recall >= 98%   (pre-gate)
//   T_high     30th percentile of in-domain dense top-1                  (strong evidence)
//   T_trgm_oos largest trigram threshold keeping in-domain recall >= 95% (lexical-fallback gate)
// Dense thresholds are per embedding model; the trigram one is model-independent. eval*.jsonl is never used.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatasetRowSchema, OosRowSchema, normalize } from "@mir/shared";
import { z } from "zod";
import { denseSearch, lexicalSearch } from "../apps/gateway/src/assistant/retrieve.ts";
import { createDb } from "../apps/gateway/src/db/client.ts";
import { createGeminiEmbedder } from "../apps/gateway/src/embeddings/gemini.ts";
import { createOllamaEmbedder } from "../apps/gateway/src/embeddings/ollama.ts";
import type { Embedder } from "../apps/gateway/src/embeddings/types.ts";
import { percentile, recallAbove, recallBelow, thresholdForRecall } from "./lib/calibration.ts";
import { databaseEnv, describeDatabase, fail, parseCliArgs, parseScriptEnv } from "./lib/cli.ts";

const DATA = (f: string) => fileURLToPath(new URL(`../data/${f}`, import.meta.url));
const IN_DOMAIN_RECALL = 0.98;
const TRIGRAM_RECALL = 0.95;
const HIGH_PERCENTILE = 0.3;

const args = parseCliArgs({ provider: { type: "string" } });
const env = parseScriptEnv({
  ...databaseEnv,
  PROFILE: z.enum(["cloud", "local", "hybrid"]).default("local"),
  EMBED_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  OLLAMA_URL: z.url().default("http://localhost:11434"),
  OLLAMA_EMBED_MODEL: z.string().default("nomic-embed-text"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_EMBED_MODEL: z.string().default("gemini-embedding-001"),
});
const provider = args.provider ?? (env.PROFILE === "local" ? "ollama" : "gemini");
if (provider !== "ollama" && provider !== "gemini") fail("--provider must be 'ollama' or 'gemini'");

function embedder(): Embedder {
  if (provider === "ollama") {
    return createOllamaEmbedder({
      host: env.OLLAMA_URL,
      model: env.OLLAMA_EMBED_MODEL,
      timeoutMs: env.EMBED_TIMEOUT_MS,
    });
  }
  if (!env.GEMINI_API_KEY) fail("GEMINI_API_KEY is required for --provider gemini");
  return createGeminiEmbedder({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_EMBED_MODEL, timeoutMs: 30_000 });
}

const jsonl = (file: string) =>
  readFileSync(DATA(file), "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as unknown);

const inDomain = jsonl("dev.jsonl").map((r) => DatasetRowSchema.parse(r).instruction);
const oos = jsonl("dev_oos.jsonl").map((r) => OosRowSchema.parse(r).instruction);
const queries = [...inDomain, ...oos];
const emb = embedder();
const { pool } = createDb({ databaseUrl: env.DATABASE_URL, timeoutMs: Math.max(env.DB_TIMEOUT_MS, 30_000) });

try {
  const kbRows = await pool.query<{ n: string }>("SELECT count(*) AS n FROM kb_entries WHERE embedding_model = $1", [
    emb.model,
  ]);
  if (Number(kbRows.rows[0]?.n) === 0)
    fail(
      `no kb_entries for ${emb.model} in ${describeDatabase(env.DATABASE_URL)}: run pnpm kb:embed -- --provider ${provider}`,
    );

  console.log(
    `Calibrating ${emb.model} on dev (${inDomain.length} in-domain + ${oos.length} OOS) against ${describeDatabase(env.DATABASE_URL)}`,
  );
  const batch = 50;
  const vectors: number[][] = [];
  for (let i = 0; i < queries.length; i += batch) {
    vectors.push(...(await emb.embedQueries(queries.slice(i, i + batch))));
    // Gemini free tier: 100 embedded texts per minute per project (see embed_kb.ts).
    if (provider === "gemini" && i + batch < queries.length) await new Promise((r) => setTimeout(r, 31_000));
  }

  const dense: number[] = [];
  const trigram: number[] = [];
  for (const [i, q] of queries.entries()) {
    const [d] = await denseSearch(pool, vectors[i]!, emb.model, 1);
    const [l] = await lexicalSearch(pool, emb.model, normalize(q), 1);
    dense.push(Number(d?.dense_sim ?? 0));
    trigram.push(Number(l?.trgm_sim ?? 0));
  }
  const n = inDomain.length;
  const denseIn = dense.slice(0, n);
  const denseOos = dense.slice(n);
  const trgmIn = trigram.slice(0, n);
  const trgmOos = trigram.slice(n);

  const T_oos = thresholdForRecall(denseIn, IN_DOMAIN_RECALL);
  const T_high = Math.floor(percentile(denseIn, HIGH_PERCENTILE) * 1000) / 1000;
  const T_trgm_oos = thresholdForRecall(trgmIn, TRIGRAM_RECALL);
  const computed_at = new Date().toISOString();
  const r3 = (x: number) => Math.round(x * 1000) / 1000;

  const file = DATA("thresholds.json");
  const existing = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  existing[emb.model] = {
    T_oos,
    T_high,
    calibration: {
      n_in_domain: n,
      n_oos: oos.length,
      in_domain_recall: r3(recallAbove(denseIn, T_oos)),
      oos_recall: r3(recallBelow(denseOos, T_oos)),
      in_domain_top1: {
        min: r3(Math.min(...denseIn)),
        p30: r3(percentile(denseIn, 0.3)),
        median: r3(percentile(denseIn, 0.5)),
      },
      oos_top1: { max: r3(Math.max(...denseOos)), median: r3(percentile(denseOos, 0.5)) },
      rule: `T_oos keeps in-domain recall >= ${IN_DOMAIN_RECALL}; T_high = p${HIGH_PERCENTILE * 100} of in-domain top-1`,
      split: "dev + dev_oos",
      computed_at,
    },
  };
  existing["trigram"] = {
    T_trgm_oos,
    calibration: {
      n_in_domain: n,
      n_oos: oos.length,
      in_domain_recall: r3(recallAbove(trgmIn, T_trgm_oos)),
      oos_recall: r3(recallBelow(trgmOos, T_trgm_oos)),
      rule: `T_trgm_oos keeps in-domain recall >= ${TRIGRAM_RECALL} (lexical fallback only)`,
      split: "dev + dev_oos",
      kb_embedding_model: emb.model,
      computed_at,
    },
  };
  writeFileSync(file, JSON.stringify(existing, null, 2) + "\n");

  console.log("\n  threshold        value   in-domain recall   OOS recall");
  console.log(
    `  T_oos (dense)    ${T_oos.toFixed(3)}   ${recallAbove(denseIn, T_oos).toFixed(3).padStart(16)}   ${recallBelow(denseOos, T_oos).toFixed(3).padStart(10)}`,
  );
  console.log(
    `  T_high (dense)   ${T_high.toFixed(3)}   ${recallAbove(denseIn, T_high).toFixed(3).padStart(16)}   ${recallBelow(denseOos, T_high).toFixed(3).padStart(10)}`,
  );
  console.log(
    `  T_trgm_oos       ${T_trgm_oos.toFixed(3)}   ${recallAbove(trgmIn, T_trgm_oos).toFixed(3).padStart(16)}   ${recallBelow(trgmOos, T_trgm_oos).toFixed(3).padStart(10)}`,
  );
  console.log(
    `\n  OOS dense top-1: max ${Math.max(...denseOos).toFixed(3)}, in-domain dense top-1: min ${Math.min(...denseIn).toFixed(3)}`,
  );
  console.log(`✓ wrote ${file}`);
} catch (err) {
  fail(`calibrate failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await pool.end();
}

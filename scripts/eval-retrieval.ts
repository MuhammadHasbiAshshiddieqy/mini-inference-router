// pnpm eval:retrieval [-- --provider ollama|gemini]
// Retrieval-only evaluation (docs/07 §2b), no LLM calls: dense vs hybrid vs lexical (the fallback) over
// dev (270) + eval (27) in-domain queries and dev_oos (15) + eval_oos (5). Decides RETRIEVAL_MODE.
//   ranking metrics (threshold-free, valid on dev): hit@1, hit@5, MRR@5 of the gold intent, kNN intent accuracy
//   gate metrics (eval* only, because dev calibrated the thresholds): OOS recall, in-domain false-gate rate
// Writes eval/results/retrieval-<model>.json and prints the table and the decision.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatasetRowSchema, OosRowSchema, normalize, type Intent } from "@mir/shared";
import { z } from "zod";
import { retrievalSignals, type Candidate } from "../apps/gateway/src/assistant/intent.ts";
import { denseSearch, hybridSearch, lexicalSearch } from "../apps/gateway/src/assistant/retrieve.ts";
import { createDb } from "../apps/gateway/src/db/client.ts";
import { createGeminiEmbedder } from "../apps/gateway/src/embeddings/gemini.ts";
import { createOllamaEmbedder } from "../apps/gateway/src/embeddings/ollama.ts";
import type { Embedder } from "../apps/gateway/src/embeddings/types.ts";
import { databaseEnv, fail, parseCliArgs, parseScriptEnv } from "./lib/cli.ts";
import { retryOnRateLimit } from "./lib/retry.ts";
import { fmtDeltaPp, fmtPct, goldRank, isConfusable, isHard, mrr, rate } from "./lib/eval-metrics.ts";

const ROOT = (f: string) => fileURLToPath(new URL(`../${f}`, import.meta.url));
const K = 5;
const DEPTH = 20;
const RRF_K = 60;
const MODES = ["dense", "hybrid", "lexical"] as const;
type Mode = (typeof MODES)[number];

const args = parseCliArgs({ provider: { type: "string", default: "ollama" } });
const env = parseScriptEnv({
  ...databaseEnv,
  OLLAMA_URL: z.url().default("http://localhost:11434"),
  OLLAMA_EMBED_MODEL: z.string().default("nomic-embed-text"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_EMBED_MODEL: z.string().default("gemini-embedding-001"),
});

function embedder(): Embedder {
  if (args.provider === "ollama")
    return createOllamaEmbedder({ host: env.OLLAMA_URL, model: env.OLLAMA_EMBED_MODEL, timeoutMs: 60_000 });
  if (args.provider !== "gemini") fail("--provider must be 'ollama' or 'gemini'");
  if (!env.GEMINI_API_KEY) fail("GEMINI_API_KEY is required for --provider gemini");
  return createGeminiEmbedder({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_EMBED_MODEL, timeoutMs: 60_000 });
}

type Query = {
  id: string;
  set: "dev" | "eval" | "dev_oos" | "eval_oos";
  text: string;
  gold: Intent | "out_of_scope";
  flags: string;
};
const jsonl = (f: string) =>
  readFileSync(ROOT(`data/${f}`), "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as unknown);
const queries: Query[] = [
  ...(["dev", "eval"] as const).flatMap((set) =>
    jsonl(`${set}.jsonl`).map((r) => {
      const row = DatasetRowSchema.parse(r);
      return { id: row.id, set, text: row.instruction, gold: row.intent, flags: row.flags };
    }),
  ),
  ...(["dev_oos", "eval_oos"] as const).flatMap((set) =>
    jsonl(`${set}.jsonl`).map((r) => {
      const row = OosRowSchema.parse(r);
      return { id: row.id, set, text: row.instruction, gold: "out_of_scope" as const, flags: "" };
    }),
  ),
];

const thresholds = JSON.parse(readFileSync(ROOT("data/thresholds.json"), "utf-8")) as Record<
  string,
  Record<string, number>
>;
const emb = embedder();
const T_oos = thresholds[emb.model]?.["T_oos"];
const T_trgm_oos = thresholds["trigram"]?.["T_trgm_oos"];
if (T_oos === undefined || T_trgm_oos === undefined)
  fail(`no calibrated thresholds for ${emb.model}: run pnpm calibrate first`);

type Result = { mode: Mode; intents: string[]; rank: number | null; knn: Intent; gateScore: number };
const { pool } = createDb({ databaseUrl: env.DATABASE_URL, timeoutMs: 30_000 });

try {
  console.log(`Retrieval eval: ${queries.length} queries, model ${emb.model}, k=${K}, depth=${DEPTH}, RRF k=${RRF_K}`);
  const vectors: number[][] = [];
  for (let i = 0; i < queries.length; i += 50) {
    vectors.push(...(await retryOnRateLimit(() => emb.embedQueries(queries.slice(i, i + 50).map((q) => q.text)))));
    // Gemini free tier: 100 embedded texts per minute per project (see embed_kb.ts).
    if (args.provider === "gemini" && i + 50 < queries.length) await new Promise((r) => setTimeout(r, 31_000));
  }

  const results = new Map<string, Result[]>();
  for (const [i, q] of queries.entries()) {
    const norm = normalize(q.text);
    const rows = {
      dense: await denseSearch(pool, vectors[i]!, emb.model, K),
      hybrid: await hybridSearch(pool, vectors[i]!, emb.model, norm, K, DEPTH, RRF_K),
      lexical: await lexicalSearch(pool, emb.model, norm, K),
    };
    results.set(
      q.id,
      MODES.map((mode) => {
        const cands: Candidate[] = rows[mode].map((r) => ({
          intent: r.intent as Intent,
          dense_sim: r.dense_sim === null ? null : Number(r.dense_sim),
          trgm_sim: r.trgm_sim === null ? null : Number(r.trgm_sim),
        }));
        const signals = retrievalSignals(mode === "lexical" ? "lexical_fallback" : mode, cands);
        const denseTop1 = rows.hybrid[0]?.dense_top1;
        const gateScore = mode === "hybrid" && denseTop1 != null ? Number(denseTop1) : signals.top1Similarity;
        const intents = cands.map((c) => c.intent);
        return { mode, intents, rank: goldRank(intents, q.gold, K), knn: signals.knnIntent, gateScore };
      }),
    );
  }

  const inDomain = queries.filter((q) => q.gold !== "out_of_scope");
  const evalIn = queries.filter((q) => q.set === "eval");
  const evalOos = queries.filter((q) => q.set === "eval_oos");
  const res = (q: Query, mode: Mode) => results.get(q.id)!.find((r) => r.mode === mode)!;
  const gate = (mode: Mode) => (mode === "lexical" ? T_trgm_oos! : T_oos!);

  const ranking = (qs: Query[], mode: Mode) => ({
    n: qs.length,
    hit1: rate(qs.map((q) => res(q, mode).rank === 1)),
    hit5: rate(qs.map((q) => res(q, mode).rank !== null)),
    mrr5: mrr(qs.map((q) => res(q, mode).rank)),
    knn_accuracy: rate(qs.map((q) => res(q, mode).knn === q.gold)),
  });
  const metrics = Object.fromEntries(
    MODES.map((mode) => [
      mode,
      {
        all: ranking(inDomain, mode),
        hard_flags: ranking(
          inDomain.filter((q) => isHard(q.flags)),
          mode,
        ),
        other_flags: ranking(
          inDomain.filter((q) => !isHard(q.flags)),
          mode,
        ),
        confusable: ranking(
          inDomain.filter((q) => isConfusable(q.gold)),
          mode,
        ),
        gate_eval_only: {
          threshold: gate(mode),
          oos_recall: rate(evalOos.map((q) => res(q, mode).gateScore < gate(mode))),
          in_domain_false_gate_rate: rate(evalIn.map((q) => res(q, mode).gateScore < gate(mode))),
          n_oos: evalOos.length,
          n_in_domain: evalIn.length,
        },
      },
    ]),
  ) as Record<
    Mode,
    {
      all: ReturnType<typeof ranking>;
      hard_flags: ReturnType<typeof ranking>;
      other_flags: ReturnType<typeof ranking>;
      confusable: ReturnType<typeof ranking>;
      gate_eval_only: {
        threshold: number;
        oos_recall: number | null;
        in_domain_false_gate_rate: number | null;
        n_oos: number;
        n_in_domain: number;
      };
    }
  >;

  // Decision rule (docs/07 §2b): hybrid only if it improves hit@1 or kNN accuracy by >= 1 pp overall or
  // >= 3 pp on hard-flag queries, AND does not reduce OOS gate recall or raise the in-domain false-gate rate.
  const d = metrics.dense;
  const h = metrics.hybrid;
  const gain = (pick: (m: typeof d) => number | null, min: number) => (pick(h) ?? 0) - (pick(d) ?? 0) >= min - 1e-9;
  const improves =
    gain((m) => m.all.hit1, 0.01) ||
    gain((m) => m.all.knn_accuracy, 0.01) ||
    gain((m) => m.hard_flags.hit1, 0.03) ||
    gain((m) => m.hard_flags.knn_accuracy, 0.03);
  const gateSafe =
    (h.gate_eval_only.oos_recall ?? 0) >= (d.gate_eval_only.oos_recall ?? 0) &&
    (h.gate_eval_only.in_domain_false_gate_rate ?? 0) <= (d.gate_eval_only.in_domain_false_gate_rate ?? 0);
  const decision = improves && gateSafe ? "hybrid" : "dense";

  const perQuery = queries.map((q) => ({
    id: q.id,
    set: q.set,
    gold: q.gold,
    flags: q.flags,
    text: q.text,
    ...Object.fromEntries(
      MODES.map((m) => [
        m,
        {
          rank: res(q, m).rank,
          knn: res(q, m).knn,
          gate_score: Math.round(res(q, m).gateScore * 1000) / 1000,
          intents: res(q, m).intents,
        },
      ]),
    ),
  }));
  const output = {
    embedding_model: emb.model,
    k: K,
    depth: DEPTH,
    rrf_k: RRF_K,
    thresholds: { T_oos, T_trgm_oos },
    sets: {
      in_domain: inDomain.length,
      dev: queries.filter((q) => q.set === "dev").length,
      eval: evalIn.length,
      oos: queries.length - inDomain.length,
    },
    metrics,
    decision: {
      mode: decision,
      hybrid_improves: improves,
      hybrid_gate_safe: gateSafe,
      rule: "hybrid only if +1 pp hit@1 or kNN overall, or +3 pp on hard flags, without worse gate metrics",
    },
    per_query: perQuery,
    created_at: new Date().toISOString(),
  };
  mkdirSync(ROOT("eval/results"), { recursive: true });
  const out = ROOT(`eval/results/retrieval-${emb.model.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  writeFileSync(out, JSON.stringify(output, null, 2) + "\n");

  const row = (label: string, pick: (m: (typeof metrics)[Mode]) => number | null) =>
    `  ${label.padEnd(30)}${MODES.map((m) => fmtPct(pick(metrics[m])).padStart(10)).join("")}${fmtDeltaPp(pick(d), pick(h)).padStart(12)}`;
  console.log(
    `\n  ${"metric (in-domain n=" + inDomain.length + ")".padEnd(30)}${MODES.map((m) => m.padStart(10)).join("")}${"hyb−dense".padStart(12)}`,
  );
  console.log(row("hit@1", (m) => m.all.hit1));
  console.log(row("hit@5", (m) => m.all.hit5));
  console.log(row("MRR@5", (m) => m.all.mrr5));
  console.log(row("kNN intent accuracy", (m) => m.all.knn_accuracy));
  console.log(row(`hit@1 hard flags (n=${d.hard_flags.n})`, (m) => m.hard_flags.hit1));
  console.log(row("kNN acc hard flags", (m) => m.hard_flags.knn_accuracy));
  console.log(row(`kNN acc confusable (n=${d.confusable.n})`, (m) => m.confusable.knn_accuracy));
  console.log(row(`OOS gate recall (eval, n=${evalOos.length})`, (m) => m.gate_eval_only.oos_recall));
  console.log(row(`false-gate rate (eval, n=${evalIn.length})`, (m) => m.gate_eval_only.in_domain_false_gate_rate));
  console.log(`\n  decision: RETRIEVAL_MODE=${decision} (hybrid improves: ${improves}, gate safe: ${gateSafe})`);
  console.log(`✓ wrote ${out}`);
} catch (err) {
  fail(`eval:retrieval failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await pool.end();
}

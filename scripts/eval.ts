// pnpm eval -- --label <name> [--gateway http://localhost:8787] [--key <eval tenant key>] [--delay-ms 0] [--limit N]
// End-to-end evaluation through the gateway HTTP API (docs/07): the real request path (auth, quota, retrieval,
// routing, streaming, metering). 27 in-domain cases (1 per intent, hard flags) + 5 OOS. Sequential by default
// (free-tier RPM); a 429 is retried once after a backoff, then recorded as an error (never silently dropped).
// Debug overrides are never used: the eval measures the real path.
// Answer quality = cosine(answer, gold response) with ONE fixed scorer for every config (nomic-embed-text).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatasetRowSchema, OosRowSchema, createSseParser, parseSseEvent, type SseEvent } from "@mir/shared";
import { z } from "zod";
import { createOllamaEmbedder } from "../apps/gateway/src/embeddings/ollama.ts";
import { fail, parseCliArgs, parseScriptEnv } from "./lib/cli.ts";
import { cosine, goldRank, isHard, mean, pct, rate } from "./lib/eval-metrics.ts";

const ROOT = (f: string) => fileURLToPath(new URL(`../${f}`, import.meta.url));
const SCORER_MODEL = "nomic-embed-text";

const args = parseCliArgs({
  label: { type: "string" },
  gateway: { type: "string", default: "http://localhost:8787" },
  key: { type: "string" },
  "delay-ms": { type: "string", default: "0" },
  "backoff-ms": { type: "string", default: "30000" },
  limit: { type: "string" },
});
const env = parseScriptEnv({
  SEED_KEY_EVAL: z.string().optional(),
  OLLAMA_URL: z.url().default("http://localhost:11434"),
});
const label = args.label ?? fail("--label is required (e.g. local-ollama, cloud-minimal)");
if (!/^[a-z0-9._-]+$/i.test(label)) fail("--label may only contain letters, digits, . _ -");
const key = args.key ?? env.SEED_KEY_EVAL ?? fail("pass --key or set SEED_KEY_EVAL (the eval tenant key)");
const gateway = args.gateway!.replace(/\/$/, "");
const delayMs = Number(args["delay-ms"]);
const backoffMs = Number(args["backoff-ms"]);

type Case = {
  id: string;
  message: string;
  gold: string;
  goldResponse: string | null;
  flags: string;
  kind: "in_domain" | "oos";
};
const jsonl = (f: string) =>
  readFileSync(ROOT(`data/${f}`), "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as unknown);
let cases: Case[] = [
  ...jsonl("eval.jsonl").map((r) => {
    const row = DatasetRowSchema.parse(r);
    return {
      id: row.id,
      message: row.instruction,
      gold: row.intent,
      goldResponse: row.response,
      flags: row.flags,
      kind: "in_domain" as const,
    };
  }),
  ...jsonl("eval_oos.jsonl").map((r) => {
    const row = OosRowSchema.parse(r);
    return {
      id: row.id,
      message: row.instruction,
      gold: "out_of_scope",
      goldResponse: null,
      flags: "",
      kind: "oos" as const,
    };
  }),
];
if (args.limit) cases = cases.slice(0, Number(args.limit));

type Record_ = {
  id: string;
  kind: Case["kind"];
  gold: string;
  flags: string;
  message: string;
  http_status: number | null;
  error: string | null;
  retried_after_429: boolean;
  outcome: string | null;
  refused: boolean;
  refusal_reason: string | null;
  final_intent: string | null;
  llm_intent: string | null;
  knn_intent: string | null;
  correct: boolean;
  retrieval_mode: string | null;
  retrieved_intents: string[];
  hit1: boolean;
  hit5: boolean;
  top1_similarity: number | null;
  confidence: string | null;
  served_by: string | null;
  fallback_fired: boolean;
  escalated: boolean;
  client_ttft_ms: number | null;
  client_total_ms: number | null;
  server_ttft_ms: number | null;
  server_latency_ms: number | null;
  usage: { prompt: number; completion: number; thinking: number; total: number; estimated: boolean } | null;
  cost_usd: number | null;
  answer: string;
  answer_similarity: number | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runCase(c: Case): Promise<Record_> {
  const rec: Record_ = {
    id: c.id,
    kind: c.kind,
    gold: c.gold,
    flags: c.flags,
    message: c.message,
    http_status: null,
    error: null,
    retried_after_429: false,
    outcome: null,
    refused: false,
    refusal_reason: null,
    final_intent: null,
    llm_intent: null,
    knn_intent: null,
    correct: false,
    retrieval_mode: null,
    retrieved_intents: [],
    hit1: false,
    hit5: false,
    top1_similarity: null,
    confidence: null,
    served_by: null,
    fallback_fired: false,
    escalated: false,
    client_ttft_ms: null,
    client_total_ms: null,
    server_ttft_ms: null,
    server_latency_ms: null,
    usage: null,
    cost_usd: null,
    answer: "",
    answer_similarity: null,
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = performance.now();
    const res = await fetch(`${gateway}/v1/support/answer`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ message: c.message }),
    }).catch((err: unknown) => err as Error);
    if (res instanceof Error) {
      rec.error = `network: ${res.message}`;
      return rec;
    }
    rec.http_status = res.status;
    if (res.status === 429 && attempt === 1) {
      rec.retried_after_429 = true;
      console.warn(`  ${c.id}: 429, retrying once after ${backoffMs} ms`);
      await sleep(backoffMs);
      continue;
    }
    if (!res.ok || !res.body) {
      rec.error = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
      return rec;
    }
    const events: SseEvent[] = [];
    const parser = createSseParser((raw) => {
      const parsed = parseSseEvent(raw.event, JSON.parse(raw.data));
      if (!parsed.ok) throw new Error(`invalid SSE event ${raw.event}`);
      events.push(parsed.event);
      if (parsed.event.event === "token" && rec.client_ttft_ms === null)
        rec.client_ttft_ms = Math.round(performance.now() - t0);
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    rec.client_total_ms = Math.round(performance.now() - t0);
    for (const e of events) {
      if (e.event === "retrieval") {
        rec.retrieval_mode = e.data.mode;
        rec.knn_intent = e.data.knn_intent;
        rec.top1_similarity = e.data.top1_similarity;
        rec.retrieved_intents = e.data.entries.map((x) => x.intent);
      } else if (e.event === "intent") {
        rec.llm_intent = e.data.llm_intent;
        rec.final_intent = e.data.final_intent;
        rec.confidence = e.data.confidence.level;
      } else if (e.event === "token") rec.answer += e.data.text;
      else if (e.event === "refusal") {
        rec.refused = true;
        rec.refusal_reason = e.data.reason;
      } else if (e.event === "error") rec.error = `${e.data.code}: ${e.data.message}`;
      else if (e.event === "done") {
        rec.outcome = e.data.outcome;
        rec.served_by = e.data.served_by?.backend_id ?? null;
        rec.fallback_fired = e.data.fallback_fired;
        rec.escalated = e.data.escalated;
        rec.server_ttft_ms = e.data.ttft_ms;
        rec.server_latency_ms = e.data.latency_ms;
        rec.cost_usd = e.data.cost_usd;
        const u = e.data.usage;
        rec.usage = {
          prompt: u.prompt_tokens,
          completion: u.completion_tokens,
          thinking: u.thinking_tokens,
          total: u.total_tokens,
          estimated: u.estimated,
        };
      }
    }
    // Intent accuracy: final intent == gold, refusals count as wrong for in-domain and right for OOS.
    rec.correct = c.kind === "oos" ? rec.refused : !rec.refused && rec.final_intent === c.gold;
    if (c.kind === "in_domain") {
      rec.hit1 = goldRank(rec.retrieved_intents, c.gold, 1) !== null;
      rec.hit5 = goldRank(rec.retrieved_intents, c.gold, 5) !== null;
    }
    return rec;
  }
  rec.error ??= "429 after one retry";
  return rec;
}

const health = await fetch(`${gateway}/healthz`)
  .then((r) => r.json() as Promise<Record<string, unknown>>)
  .catch(() => null);
if (!health) fail(`gateway not reachable at ${gateway}`);
console.log(
  `Eval "${label}": ${cases.length} cases against ${gateway} (profile ${String(health["profile"])}, embedding ${String(health["embedding_model"])})`,
);

const records: Record_[] = [];
for (const [i, c] of cases.entries()) {
  const rec = await runCase(c);
  records.push(rec);
  const mark = rec.error ? "ERR" : rec.correct ? " ✓ " : " ✗ ";
  console.log(
    `  [${String(i + 1).padStart(2)}/${cases.length}] ${mark} ${c.id.padEnd(13)} gold=${c.gold.padEnd(24)} final=${String(rec.final_intent ?? (rec.refused ? `refused:${rec.refusal_reason}` : (rec.error ?? "-"))).padEnd(34)} ${rec.client_total_ms ?? "-"} ms`,
  );
  if (delayMs > 0 && i < cases.length - 1) await sleep(delayMs);
}

// Answer quality: one fixed scorer for every configuration, on answered in-domain cases only.
let scorerNote = `cosine(answer, gold response) with ${SCORER_MODEL} (search_document: prefix on both), answered in-domain cases only`;
const answered = records.filter((r) => r.kind === "in_domain" && !r.refused && r.answer.trim());
try {
  const scorer = createOllamaEmbedder({ host: env.OLLAMA_URL, model: SCORER_MODEL, timeoutMs: 60_000 });
  const goldById = new Map(cases.map((c) => [c.id, c.goldResponse ?? ""]));
  const texts = answered.flatMap((r) => [r.answer, goldById.get(r.id) ?? ""]);
  const vectors = texts.length ? await scorer.embedDocuments(texts) : [];
  answered.forEach(
    (r, i) => (r.answer_similarity = Math.round(cosine(vectors[2 * i]!, vectors[2 * i + 1]!) * 1000) / 1000),
  );
} catch (err) {
  scorerNote = `scorer unavailable (${err instanceof Error ? err.message : String(err)}): answer similarity not computed`;
  console.warn(`  ${scorerNote}`);
}

const inDomain = records.filter((r) => r.kind === "in_domain");
const oos = records.filter((r) => r.kind === "oos");
const ok = records.filter((r) => !r.error || r.outcome);
const num = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);
const llmCases = records.filter((r) => (r.usage?.total ?? 0) > 0);
const totalCost = records.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
const aggregates = {
  n: {
    total: records.length,
    in_domain: inDomain.length,
    oos: oos.length,
    errors: records.filter((r) => r.error && !r.outcome).length,
  },
  intent_accuracy: rate(inDomain.map((r) => r.correct)),
  knn_accuracy: rate(inDomain.map((r) => r.knn_intent === r.gold)),
  llm_header_accuracy: rate(inDomain.filter((r) => r.llm_intent).map((r) => r.llm_intent === r.gold)),
  hard_flag_intent_accuracy: rate(inDomain.filter((r) => isHard(r.flags)).map((r) => r.correct)),
  retrieval_hit1: rate(inDomain.map((r) => r.hit1)),
  retrieval_hit5: rate(inDomain.map((r) => r.hit5)),
  oos_refusal_rate: rate(oos.map((r) => r.refused)),
  in_domain_false_refusal_rate: rate(inDomain.map((r) => r.refused)),
  refusal_reasons: Object.fromEntries(
    [...new Set(records.flatMap((r) => (r.refusal_reason ? [r.refusal_reason] : [])))].map((k) => [
      k,
      records.filter((r) => r.refusal_reason === k).length,
    ]),
  ),
  answer_similarity: {
    mean: mean(num(answered.map((r) => r.answer_similarity))),
    p50: pct(num(answered.map((r) => r.answer_similarity)), 0.5),
    min: Math.min(...num(answered.map((r) => r.answer_similarity))),
    n: answered.length,
    method: scorerNote,
  },
  latency_ms: {
    client_ttft_p50: pct(num(ok.map((r) => r.client_ttft_ms)), 0.5),
    client_ttft_p95: pct(num(ok.map((r) => r.client_ttft_ms)), 0.95),
    client_total_p50: pct(num(ok.map((r) => r.client_total_ms)), 0.5),
    client_total_p95: pct(num(ok.map((r) => r.client_total_ms)), 0.95),
    server_ttft_p50: pct(num(ok.map((r) => r.server_ttft_ms)), 0.5),
    server_latency_p50: pct(num(ok.map((r) => r.server_latency_ms)), 0.5),
  },
  // Per request that reached a model (pre-gate refusals use no tokens and would dilute the mean).
  tokens_mean: {
    prompt: mean(num(llmCases.map((r) => r.usage?.prompt ?? null))),
    completion: mean(num(llmCases.map((r) => r.usage?.completion ?? null))),
    thinking: mean(num(llmCases.map((r) => r.usage?.thinking ?? null))),
    n_llm_cases: llmCases.length,
    estimated_cases: records.filter((r) => r.usage?.estimated).length,
  },

  cost_usd: {
    total: totalCost,
    mean_per_case: records.length ? totalCost / records.length : null,
    per_1000_requests: records.length ? (totalCost / records.length) * 1000 : null,
  },
  reliability: {
    fallback_rate: rate(records.map((r) => r.fallback_fired)),
    escalation_rate: rate(records.map((r) => r.escalated)),
    error_rate: rate(records.map((r) => Boolean(r.error))),
    outcomes: Object.fromEntries(
      [...new Set(records.map((r) => r.outcome ?? "error"))].map((o) => [
        o,
        records.filter((r) => (r.outcome ?? "error") === o).length,
      ]),
    ),
  },
};

const result = { label, gateway, fingerprint: health, run_at: new Date().toISOString(), aggregates, cases: records };
mkdirSync(ROOT("eval/results"), { recursive: true });
const out = ROOT(`eval/results/${label}.json`);
writeFileSync(out, JSON.stringify(result, null, 2) + "\n");

const p = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
console.log(
  `\n  intent accuracy ${p(aggregates.intent_accuracy)} (kNN ${p(aggregates.knn_accuracy)}, LLM header ${p(aggregates.llm_header_accuracy)})`,
);
console.log(
  `  OOS refusal ${p(aggregates.oos_refusal_rate)}, in-domain false refusal ${p(aggregates.in_domain_false_refusal_rate)}, hit@1 ${p(aggregates.retrieval_hit1)}`,
);
console.log(`  answer similarity mean ${aggregates.answer_similarity.mean?.toFixed(3) ?? "—"} (n=${answered.length})`);
console.log(
  `  TTFT p50/p95 ${aggregates.latency_ms.client_ttft_p50}/${aggregates.latency_ms.client_ttft_p95} ms, total p50/p95 ${aggregates.latency_ms.client_total_p50}/${aggregates.latency_ms.client_total_p95} ms`,
);
console.log(
  `  cost total $${totalCost.toFixed(6)} (per 1k requests $${aggregates.cost_usd.per_1000_requests?.toFixed(4)}), escalation ${p(aggregates.reliability.escalation_rate)}, fallback ${p(aggregates.reliability.fallback_rate)}`,
);
console.log(`✓ wrote ${out}`);

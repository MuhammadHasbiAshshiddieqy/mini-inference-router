import { isHard, mean, pct, rate } from "./eval-metrics.ts";

// Aggregates for one end-to-end eval run (docs/07 §3), computed from the per-case records only, so
// `eval:compare` can recompute any stored run with the current definitions.
//
// The mock backend answers with the kNN intent as its header and the top-1 KB answer, so cases it served
// would inflate "LLM header accuracy" and answer quality. Those are therefore also reported on the cases
// served by a real model only, next to the served_by distribution.

export type EvalCase = {
  kind: "in_domain" | "oos";
  gold: string;
  flags: string;
  error: string | null;
  outcome: string | null;
  refused: boolean;
  refusal_reason: string | null;
  llm_intent: string | null;
  knn_intent: string | null;
  correct: boolean;
  hit1: boolean;
  hit5: boolean;
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

const num = (xs: (number | null | undefined)[]) => xs.filter((x): x is number => typeof x === "number");
const countBy = <T>(xs: T[], key: (x: T) => string) =>
  xs.reduce<Record<string, number>>((acc, x) => ({ ...acc, [key(x)]: (acc[key(x)] ?? 0) + 1 }), {});
const byModel = (r: EvalCase) => r.served_by !== null && r.served_by !== "mock";

export function aggregate(records: EvalCase[], similarityMethod: string) {
  const inDomain = records.filter((r) => r.kind === "in_domain");
  const oos = records.filter((r) => r.kind === "oos");
  const answered = inDomain.filter((r) => !r.refused && r.answer.trim());
  const ok = records.filter((r) => !r.error || r.outcome);
  const llmCases = records.filter((r) => (r.usage?.total ?? 0) > 0);
  const totalCost = records.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const sims = (xs: EvalCase[]) => num(xs.map((r) => r.answer_similarity));

  return {
    n: {
      total: records.length,
      in_domain: inDomain.length,
      oos: oos.length,
      errors: records.filter((r) => r.error && !r.outcome).length,
    },
    intent_accuracy: rate(inDomain.map((r) => r.correct)),
    knn_accuracy: rate(inDomain.map((r) => r.knn_intent === r.gold)),
    llm_header_accuracy: rate(inDomain.filter((r) => r.llm_intent && byModel(r)).map((r) => r.llm_intent === r.gold)),
    hard_flag_intent_accuracy: rate(inDomain.filter((r) => isHard(r.flags)).map((r) => r.correct)),
    retrieval_hit1: rate(inDomain.map((r) => r.hit1)),
    retrieval_hit5: rate(inDomain.map((r) => r.hit5)),
    oos_refusal_rate: rate(oos.map((r) => r.refused)),
    in_domain_false_refusal_rate: rate(inDomain.map((r) => r.refused)),
    refusal_reasons: countBy(
      records.filter((r) => r.refusal_reason),
      (r) => r.refusal_reason!,
    ),
    served_by: countBy(records, (r) => r.served_by ?? "none"),
    model_answers: {
      // In-domain cases answered by a real model (not the mock, not refused).
      n: inDomain.filter((r) => byModel(r) && !r.refused).length,
      intent_accuracy: rate(inDomain.filter((r) => byModel(r) && !r.refused).map((r) => r.correct)),
      answer_similarity_mean: mean(sims(answered.filter(byModel))),
    },
    answer_similarity: {
      mean: mean(sims(answered)),
      p50: pct(sims(answered), 0.5),
      n: sims(answered).length,
      method: similarityMethod,
    },
    latency_ms: {
      client_ttft_p50: pct(num(ok.map((r) => r.client_ttft_ms)), 0.5),
      client_ttft_p95: pct(num(ok.map((r) => r.client_ttft_ms)), 0.95),
      client_total_p50: pct(num(ok.map((r) => r.client_total_ms)), 0.5),
      client_total_p95: pct(num(ok.map((r) => r.client_total_ms)), 0.95),
      server_ttft_p50: pct(num(ok.map((r) => r.server_ttft_ms)), 0.5),
      server_latency_p50: pct(num(ok.map((r) => r.server_latency_ms)), 0.5),
      // Same, on cases a real model served first try (no fallback): the model's own latency.
      model_ttft_p50: pct(
        num(records.filter((r) => byModel(r) && !r.fallback_fired).map((r) => r.client_ttft_ms)),
        0.5,
      ),
    },
    // Per request that reached a model (pre-gate refusals use no tokens and would dilute the mean).
    tokens_mean: {
      prompt: mean(num(llmCases.map((r) => r.usage?.prompt))),
      completion: mean(num(llmCases.map((r) => r.usage?.completion))),
      thinking: mean(num(llmCases.map((r) => r.usage?.thinking))),
      n_llm_cases: llmCases.length,
      estimated_cases: records.filter((r) => r.usage?.estimated).length,
    },
    // Over all cases: free pre-gate refusals are part of the real traffic mix.
    cost_usd: {
      total: totalCost,
      mean_per_case: records.length ? totalCost / records.length : null,
      per_1000_requests: records.length ? (totalCost / records.length) * 1000 : null,
    },
    reliability: {
      fallback_rate: rate(records.map((r) => r.fallback_fired)),
      escalation_rate: rate(records.map((r) => r.escalated)),
      error_rate: rate(records.map((r) => Boolean(r.error))),
      outcomes: countBy(records, (r) => r.outcome ?? "error"),
    },
  };
}

export type Aggregates = ReturnType<typeof aggregate>;

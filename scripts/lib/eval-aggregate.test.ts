import { describe, expect, it } from "vitest";
import { aggregate, type EvalCase } from "./eval-aggregate.ts";

const base: EvalCase = {
  kind: "in_domain",
  gold: "track_refund",
  flags: "BLQ",
  error: null,
  outcome: "ok",
  refused: false,
  refusal_reason: null,
  llm_intent: "track_refund",
  knn_intent: "track_refund",
  correct: true,
  hit1: true,
  hit5: true,
  served_by: "gemini-3.5-flash",
  fallback_fired: false,
  escalated: false,
  client_ttft_ms: 1000,
  client_total_ms: 1500,
  server_ttft_ms: 900,
  server_latency_ms: 1400,
  usage: { prompt: 1000, completion: 100, thinking: 0, total: 1100, estimated: false },
  cost_usd: 0.002,
  answer: "Check Refunds.",
  answer_similarity: 0.9,
};
const c = (o: Partial<EvalCase>): EvalCase => ({ ...base, ...o });

describe("eval aggregates", () => {
  const cases = [
    c({}),
    // Wrong model header, answered anyway.
    c({ llm_intent: "get_refund", correct: false, answer_similarity: 0.7 }),
    // Served by the mock after fallback: header = kNN by construction, so it must not count as model accuracy.
    c({
      served_by: "mock",
      fallback_fired: true,
      outcome: "ok_after_fallback",
      client_ttft_ms: 9000,
      answer_similarity: 0.99,
      cost_usd: 0,
      usage: { prompt: 900, completion: 80, thinking: 0, total: 980, estimated: true },
    }),
    // Pre-gate refusal: no tokens, no model.
    c({
      refused: true,
      refusal_reason: "low_retrieval_similarity",
      correct: false,
      served_by: null,
      llm_intent: null,
      outcome: "refused",
      usage: { prompt: 0, completion: 0, thinking: 0, total: 0, estimated: false },
      cost_usd: 0,
      answer: "",
      answer_similarity: null,
      client_ttft_ms: null,
    }),
    c({
      kind: "oos",
      gold: "out_of_scope",
      refused: true,
      correct: true,
      served_by: null,
      llm_intent: null,
      outcome: "refused",
      usage: null,
      cost_usd: 0,
      answer: "",
      answer_similarity: null,
      client_ttft_ms: null,
    }),
  ];
  const a = aggregate(cases, "test");

  it("separates answers served by a real model from mock answers", () => {
    expect(a.intent_accuracy).toBe(2 / 4); // all in-domain, refusals count as wrong
    expect(a.model_answers).toEqual({ n: 2, intent_accuracy: 0.5, answer_similarity_mean: 0.8 });
    expect(a.llm_header_accuracy).toBe(0.5); // the mock's header is excluded
    expect(a.served_by).toEqual({ "gemini-3.5-flash": 2, mock: 1, none: 2 });
  });

  it("refusals, tokens per LLM request, cost over all cases, model latency without fallback", () => {
    expect(a.in_domain_false_refusal_rate).toBe(0.25);
    expect(a.oos_refusal_rate).toBe(1);
    expect(a.tokens_mean.prompt).toBeCloseTo((1000 + 1000 + 900) / 3);
    expect(a.cost_usd.per_1000_requests).toBeCloseTo((0.004 / 5) * 1000);
    expect(a.latency_ms.model_ttft_p50).toBe(1000);
    expect(a.reliability.fallback_rate).toBe(0.2);
  });
});

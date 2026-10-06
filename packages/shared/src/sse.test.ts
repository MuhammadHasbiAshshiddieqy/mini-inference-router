import { describe, expect, it } from "vitest";
import { SSE_EVENT_NAMES, parseSseEvent } from "./sse.ts";

const usage = { prompt_tokens: 10, completion_tokens: 5, thinking_tokens: 0, total_tokens: 15, estimated: false };
const quota = { limit: 1000, used: 15, remaining: 985 };

describe("SSE contract", () => {
  it("covers every event in docs/03 §4", () => {
    expect(SSE_EVENT_NAMES.sort()).toEqual(
      [
        "attempt_failed",
        "done",
        "error",
        "intent",
        "meta",
        "refusal",
        "retrieval",
        "route",
        "token",
        "tool_call",
      ].sort(),
    );
  });

  it("parses a valid done event", () => {
    const parsed = parseSseEvent("done", {
      outcome: "ok_after_fallback",
      served_by: { backend_id: "gemini-3-flash", model: "gemini-3-flash-preview" },
      fallback_fired: true,
      escalated: false,
      usage,
      latency_ms: 1200,
      ttft_ms: 400,
      cost_usd: 0.000123,
      quota,
      decisions: [],
    });
    expect(parsed.ok).toBe(true);
  });

  it("parses a support intent event with confidence signals", () => {
    const parsed = parseSseEvent("intent", {
      llm_intent: "track_refund",
      final_intent: "track_refund",
      confidence: {
        level: "high",
        score: 0.91,
        signals: {
          top1_similarity: 0.88,
          vote_share: 0.8,
          knn_intent: "track_refund",
          llm_intent: "track_refund",
          agree: true,
          escalated: false,
          retrieval_mode: "dense",
          thresholds: { T_oos: 0.55, T_high: 0.75 },
        },
      },
    });
    expect(parsed.ok).toBe(true);
  });

  it("rejects invalid data with issues instead of throwing", () => {
    const parsed = parseSseEvent("attempt_failed", { attempt: 1, backend_id: "mock", status: "exploded" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("invalid_data");
  });

  it("reports unknown event names so clients can ignore them", () => {
    expect(parseSseEvent("ping", {})).toEqual({ ok: false, reason: "unknown_event", name: "ping" });
  });

  it("rejects an intent label outside the 28-label enum", () => {
    const parsed = parseSseEvent("retrieval", {
      mode: "hybrid",
      entries: [],
      knn_intent: "order_pizza",
      vote_share: 1,
      top1_similarity: 0.2,
    });
    expect(parsed.ok).toBe(false);
  });
});

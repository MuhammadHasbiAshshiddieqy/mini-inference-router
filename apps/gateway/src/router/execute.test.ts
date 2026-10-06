import type { BackendId } from "@mir/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendError, type Backend, type BackendSpec, type StreamChunk } from "../backends/types.ts";
import { priceTable } from "../config/pricing.ts";
import { createLogger } from "../logger.ts";
import { execute, totals, type ExecuteHooks, type ExecuteInput } from "./execute.ts";

// docs/04 §8: fallback, timeouts and commit semantics with fake backends and fake timers (no network).

const prices = priceTable("0");
const logger = createLogger("silent");

function spec(id: BackendId, priority: number): BackendSpec {
  return {
    id,
    kind: id === "mock" ? "mock" : id === "ollama" ? "ollama" : "gemini",
    model: `${id}-model`,
    priority,
    supportsTools: id !== "mock",
    ttftTimeoutMs: 1_000,
    totalTimeoutMs: 5_000,
    price: prices[id],
  };
}
const PRIMARY = spec("gemini-3.5-flash", 0);
const FALLBACK = spec("gemini-3-flash", 1);
const MOCK = spec("mock", 2);

type Step = { wait?: number; text?: string; usage?: [number, number, number]; fail?: BackendError };

// A scripted backend. `stubborn` ignores the abort signal while waiting, like a provider that never notices.
function fake(steps: Step[], opts: { stubborn?: boolean } = {}) {
  const seen: { calls: number; signals: AbortSignal[] } = { calls: 0, signals: [] };
  const backendFor = (s: BackendSpec): Backend => ({
    spec: s,
    async *stream(req): AsyncIterable<StreamChunk> {
      seen.calls++;
      seen.signals.push(req.signal);
      for (const step of steps) {
        if (step.wait) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, step.wait);
            if (!opts.stubborn) {
              req.signal.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(new BackendError("aborted", "aborted"));
              });
            }
          });
        }
        if (step.fail) throw step.fail;
        if (step.text) yield { type: "text", text: step.text };
        if (step.usage) {
          const [promptTokens, completionTokens, thinkingTokens] = step.usage;
          yield { type: "usage", promptTokens, completionTokens, thinkingTokens, estimated: false };
        }
      }
    },
  });
  return { seen, backendFor };
}

function run(
  backends: Partial<Record<BackendId, ReturnType<typeof fake>>>,
  overrides: Partial<ExecuteInput> & { commitOnFirstToken?: boolean } = {},
) {
  const events: string[] = [];
  const text: string[] = [];
  const hooks: ExecuteHooks = {
    onRoute: (e) => void events.push(`route #${e.attempt} ${e.backendId} (${e.reason})`),
    onAttemptFailed: (e) => void events.push(`failed #${e.attempt} ${e.backendId} ${e.status}`),
    onChunk: (chunk, ctx) => {
      if (chunk.type === "text") {
        text.push(chunk.text);
        if (overrides.commitOnFirstToken ?? true) ctx.commit();
      }
    },
  };
  const promise = execute({
    candidates: [PRIMARY, FALLBACK, MOCK],
    backendFor: (s) => {
      const b = backends[s.id];
      if (!b) throw new Error(`no fake for ${s.id}`);
      return b.backendFor(s);
    },
    request: { messages: [{ role: "user", content: "hi" }], maxOutputTokens: 64 },
    hooks,
    logger,
    now: () => Date.now(),
    ...overrides,
  });
  return { promise, events, text };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const ok = (t = "hello") => fake([{ wait: 100, text: t }, { usage: [10, 5, 2] }]);

describe("execute", () => {
  it("serves from the primary when it succeeds", async () => {
    const primary = ok();
    const r = run({ "gemini-3.5-flash": primary });
    await vi.runAllTimersAsync();
    const result = await r.promise;
    expect(result).toMatchObject({ outcome: "ok", fallbackFired: false, ttftMs: 100, error: null });
    expect(result.servedBy).toEqual({ backendId: "gemini-3.5-flash", model: "gemini-3.5-flash-model" });
    expect(result.attempts.map((a) => [a.reason, a.status, a.ttftMs])).toEqual([["primary", "ok", 100]]);
    expect(r.text).toEqual(["hello"]);
    // 10 × 1.50 + (5 + 2) × 9.00 = 78 µ$
    expect(result.attempts[0]?.costUsd).toBe("0.00007800");
  });

  it("429 on the primary → falls back, and records both attempts with reasons", async () => {
    const r = run({
      "gemini-3.5-flash": fake([{ wait: 50, fail: new BackendError("rate_limited", "gemini 429") }]),
      "gemini-3-flash": ok("from fallback"),
    });
    await vi.runAllTimersAsync();
    const result = await r.promise;
    expect(result).toMatchObject({ outcome: "ok", fallbackFired: true });
    expect(result.servedBy?.backendId).toBe("gemini-3-flash");
    expect(result.attempts.map((a) => [a.attempt, a.backendId, a.reason, a.status])).toEqual([
      [1, "gemini-3.5-flash", "primary", "rate_limited"],
      [2, "gemini-3-flash", "fallback:rate_limited", "ok"],
    ]);
    expect(r.events).toEqual([
      "route #1 gemini-3.5-flash (primary)",
      "failed #1 gemini-3.5-flash rate_limited",
      "route #2 gemini-3-flash (fallback:rate_limited)",
    ]);
  });

  it("TTFT timeout → falls back, even if the provider ignores the abort signal", async () => {
    const stalled = fake([{ wait: 60_000, text: "too late" }], { stubborn: true });
    const r = run({ "gemini-3.5-flash": stalled, "gemini-3-flash": ok() });
    await vi.advanceTimersByTimeAsync(1_000); // PRIMARY.ttftTimeoutMs
    await vi.advanceTimersByTimeAsync(200);
    const result = await r.promise;
    expect(result.attempts.map((a) => [a.status, a.latencyMs])).toEqual([
      ["timeout_ttft", 1_000],
      ["ok", 100],
    ]);
    expect(result.outcome).toBe("ok");
    expect(stalled.seen.signals[0]?.aborted).toBe(true); // upstream was told to stop
  });

  it("total timeout before commit → falls back (support header phase)", async () => {
    const slowAfterFirstChunk = fake([
      { wait: 100, text: "INTENT: track_" },
      { wait: 60_000, text: "refund" },
    ]);
    const r = run({ "gemini-3.5-flash": slowAfterFirstChunk, "gemini-3-flash": ok() }, { commitOnFirstToken: false });
    await vi.advanceTimersByTimeAsync(5_000); // PRIMARY.totalTimeoutMs
    await vi.advanceTimersByTimeAsync(200);
    const result = await r.promise;
    expect(result.attempts.map((a) => a.status)).toEqual(["timeout_total", "ok"]);
    expect(result.attempts[0]?.ttftMs).toBe(100);
  });

  it("network error → falls back with reason fallback:network_error", async () => {
    const r = run({
      "gemini-3.5-flash": fake([{ fail: new BackendError("network_error", "ECONNREFUSED") }]),
      "gemini-3-flash": ok(),
    });
    await vi.runAllTimersAsync();
    const result = await r.promise;
    expect(result.attempts.map((a) => a.reason)).toEqual(["primary", "fallback:network_error"]);
  });

  it("debug.force_fail fails a backend synthetically without calling it", async () => {
    const primary = ok();
    const r = run({ "gemini-3.5-flash": primary, "gemini-3-flash": ok() }, { forceFail: ["gemini-3.5-flash"] });
    await vi.runAllTimersAsync();
    const result = await r.promise;
    expect(primary.seen.calls).toBe(0);
    expect(result.attempts.map((a) => [a.status, a.errorDetail])).toEqual([
      ["forced_failure", "debug.force_fail"],
      ["ok", null],
    ]);
    expect(result.attempts[1]?.reason).toBe("fallback:forced_failure");
  });

  it("failure AFTER the first token was forwarded → partial_error, no fallback", async () => {
    const fallback = ok();
    const r = run({
      "gemini-3.5-flash": fake([
        { wait: 50, text: "Sure, to cancel" },
        { wait: 50, fail: new BackendError("upstream_error", "stream reset") },
      ]),
      "gemini-3-flash": fallback,
    });
    await vi.runAllTimersAsync();
    const result = await r.promise;
    expect(result.outcome).toBe("partial_error");
    expect(result.servedBy?.backendId).toBe("gemini-3.5-flash");
    expect(result.attempts.map((a) => [a.status, a.errorDetail])).toEqual([
      ["mid_stream_error", "upstream_error: stream reset"],
    ]);
    expect(fallback.seen.calls).toBe(0);
    expect(r.text).toEqual(["Sure, to cancel"]);
  });

  it("every candidate fails → all_backends_failed with one attempt row each", async () => {
    const r = run({
      "gemini-3.5-flash": fake([{ fail: new BackendError("rate_limited", "429") }]),
      "gemini-3-flash": fake([{ fail: new BackendError("upstream_error", "503") }]),
      mock: fake([{ fail: new BackendError("upstream_error", "mock failure") }]),
    });
    await vi.runAllTimersAsync();
    const result = await r.promise;
    expect(result.outcome).toBe("all_backends_failed");
    expect(result.servedBy).toBeNull();
    expect(result.attempts.map((a) => [a.reason, a.status])).toEqual([
      ["primary", "rate_limited"],
      ["fallback:rate_limited", "upstream_error"],
      ["fallback:upstream_error", "upstream_error"],
    ]);
    expect(result.error?.message).toMatch(/all 3 candidates failed; last: mock failure/);
  });

  it("client abort → client_aborted, upstream aborted, no fallback", async () => {
    const client = new AbortController();
    const primary = fake([{ wait: 10_000, text: "late" }], { stubborn: true });
    const fallback = ok();
    const r = run({ "gemini-3.5-flash": primary, "gemini-3-flash": fallback }, { clientSignal: client.signal });
    await vi.advanceTimersByTimeAsync(300);
    client.abort();
    await vi.advanceTimersByTimeAsync(10);
    const result = await r.promise;
    expect(result.outcome).toBe("client_aborted");
    expect(result.attempts.map((a) => a.status)).toEqual(["aborted"]);
    expect(primary.seen.signals[0]?.aborted).toBe(true);
    expect(fallback.seen.calls).toBe(0);
  });

  it("a consumer quality stop (invalid_output) ends the run without fallback", async () => {
    const fallback = ok();
    const r = run(
      { "gemini-3.5-flash": fake([{ wait: 10, text: "Sure! Here is" }]), "gemini-3-flash": fallback },
      {
        hooks: {
          onChunk: () => {
            throw new BackendError("invalid_output", "missing INTENT header", { retryable: false });
          },
        },
      },
    );
    await vi.runAllTimersAsync();
    const result = await r.promise;
    expect(result.outcome).toBe("stopped");
    expect(result.attempts.map((a) => a.status)).toEqual(["invalid_output"]);
    expect(fallback.seen.calls).toBe(0);
  });

  it("totals sum usage and cost over all attempts, failed ones included", async () => {
    const r = run({
      "gemini-3.5-flash": fake([{ usage: [100, 0, 20] }, { fail: new BackendError("upstream_error", "empty") }]),
      "gemini-3-flash": ok(),
    });
    await vi.runAllTimersAsync();
    const result = await r.promise;
    expect(totals(result.attempts)).toEqual({
      promptTokens: 110,
      completionTokens: 5,
      thinkingTokens: 22,
      totalTokens: 137,
      estimated: false,
      // primary: 100 × 1.50 + 20 × 9.00 = 330 µ$; fallback: 10 × 0.50 + 7 × 3.00 = 26 µ$
      costUsd: "0.00035600",
    });
  });

  it("onAttemptDone sees every attempt, and attempt numbering can continue after escalation", async () => {
    const done: string[] = [];
    const r = run(
      { "gemini-3.5-flash": fake([{ fail: new BackendError("rate_limited", "429") }]), "gemini-3-flash": ok() },
      {
        firstAttemptNo: 2,
        firstReason: "escalation:invalid_output",
        hooks: {
          onChunk: () => undefined,
          onAttemptDone: (a) => void done.push(`#${a.attempt} ${a.reason} ${a.status}`),
        },
      },
    );
    await vi.runAllTimersAsync();
    await r.promise;
    expect(done).toEqual(["#2 escalation:invalid_output rate_limited", "#3 fallback:rate_limited ok"]);
  });
});

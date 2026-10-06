import type { AttemptStatus } from "@mir/shared";
import type { Logger } from "pino";
import {
  BackendError,
  estimateTokenCount,
  type Backend,
  type BackendSpec,
  type GenerateRequest,
  type StreamChunk,
  type UsageChunk,
} from "../backends/types.ts";
import { costUsd, sumUsd } from "../config/pricing.ts";

// Execution with fallback (docs/04 §5). Tries candidates in priority order. Each attempt has a TTFT timer
// and a total timer and is linked to the client's abort signal. Fallback happens ONLY before the response is
// committed, i.e. before content was forwarded to the client: after that a failure is reported, never silently
// retried, because the user has already seen part of an answer.
//
// The consumer decides when content is committed (`ctx.commit()`): the chat route commits on the first token
// it forwards; the support assistant buffers the INTENT header first, so a failure during the header can
// still fall back. A consumer may stop the run with a non-retryable BackendError (e.g. `invalid_output`),
// which is a quality signal handled by escalation (docs/04 §6), not a backend failure.

export type ContentChunk = Exclude<StreamChunk, UsageChunk>;

export type AttemptResult = {
  attempt: number;
  backendId: string;
  model: string;
  reason: string; // 'primary' | 'fallback:<prev_status>' | 'escalation:<why>'
  status: AttemptStatus;
  errorDetail: string | null;
  usage: UsageChunk | undefined;
  costUsd: string;
  latencyMs: number;
  ttftMs: number | null;
  startedAt: Date;
};

export type ExecuteHooks = {
  onRoute?: (e: { attempt: number; backendId: string; model: string; reason: string }) => void | Promise<void>;
  onAttemptFailed?: (e: {
    attempt: number;
    backendId: string;
    status: AttemptStatus;
    error: string;
    latencyMs: number;
  }) => void | Promise<void>;
  // Called once per attempt (success or failure), e.g. to insert a route_attempts row.
  onAttemptDone?: (a: AttemptResult) => void | Promise<void>;
  onChunk: (chunk: ContentChunk, ctx: { commit: () => void; backend: BackendSpec }) => void | Promise<void>;
  // Called when a stream ends normally, before the attempt is recorded as ok. May throw like onChunk
  // (e.g. the support parser rejects output that ended inside the INTENT header).
  onEnd?: (ctx: { backend: BackendSpec }) => void | Promise<void>;
};

export type ExecuteInput = {
  candidates: readonly BackendSpec[];
  backendFor: (spec: BackendSpec) => Backend;
  request: Omit<GenerateRequest, "signal">;
  hooks: ExecuteHooks;
  logger: Logger;
  clientSignal?: AbortSignal;
  forceFail?: readonly string[]; // debug.force_fail: these backends fail synthetically with `forced_failure`
  firstReason?: string; // default 'primary'; escalation passes 'escalation:<why>'
  firstAttemptNo?: number; // continue numbering after an earlier run (escalation)
  now?: () => number; // injectable clock for tests
};

export type ExecuteOutcome = "ok" | "partial_error" | "all_backends_failed" | "client_aborted" | "stopped";

export type ExecuteResult = {
  outcome: ExecuteOutcome;
  servedBy: { backendId: string; model: string } | null;
  fallbackFired: boolean; // a later candidate was tried because an earlier one failed
  attempts: AttemptResult[];
  ttftMs: number | null; // from the start of this run to the first content chunk of the served attempt
  error: { status: AttemptStatus; message: string } | null;
};

const CLIENT_ABORT = "client_aborted";

// Races one `next()` against the attempt's abort signal, so timeouts fire even if a provider ignores aborts.
function nextOrAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) return Promise.reject(new BackendError("aborted", `aborted: ${String(signal.reason)}`));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new BackendError("aborted", `aborted: ${String(signal.reason)}`));
    signal.addEventListener("abort", onAbort, { once: true });
    iterator.next().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function classify(err: unknown, signal: AbortSignal): { status: AttemptStatus; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (signal.aborted) {
    const reason = String(signal.reason);
    if (reason === "timeout_ttft") return { status: "timeout_ttft", message: "no content before the TTFT timeout" };
    if (reason === "timeout_total") return { status: "timeout_total", message: "attempt exceeded the total timeout" };
    if (reason === CLIENT_ABORT) return { status: "aborted", message: "client disconnected" };
  }
  if (err instanceof BackendError) return { status: err.status, message };
  return { status: "upstream_error", message };
}

export async function execute(input: ExecuteInput): Promise<ExecuteResult> {
  const now = input.now ?? (() => performance.now());
  const runStart = now();
  const attempts: AttemptResult[] = [];
  const firstNo = input.firstAttemptNo ?? 1;
  let committed = false;
  let prevStatus: AttemptStatus | undefined;
  const promptText = [input.request.system ?? "", ...input.request.messages.map((m) => m.content)].join("\n");

  const finish = (
    outcome: ExecuteOutcome,
    served: BackendSpec | null,
    ttftMs: number | null,
    error: ExecuteResult["error"],
  ): ExecuteResult => ({
    outcome,
    servedBy: served ? { backendId: served.id, model: served.model } : null,
    // The loop only moves to the next candidate after a failure, so more than one attempt means fallback fired.
    fallbackFired: attempts.length > 1,
    attempts,
    ttftMs,
    error,
  });

  const record = async (a: AttemptResult) => {
    attempts.push(a);
    input.logger.info(
      { backend_id: a.backendId, attempt: a.attempt, reason: a.reason, status: a.status, latency_ms: a.latencyMs },
      "attempt",
    );
    if (a.status !== "ok") {
      await input.hooks.onAttemptFailed?.({
        attempt: a.attempt,
        backendId: a.backendId,
        status: a.status,
        error: a.errorDetail ?? a.status,
        latencyMs: a.latencyMs,
      });
    }
    await input.hooks.onAttemptDone?.(a);
  };

  for (const [index, spec] of input.candidates.entries()) {
    if (input.clientSignal?.aborted) return finish("client_aborted", null, null, null);

    const attemptNo = firstNo + index;
    const reason = index === 0 ? (input.firstReason ?? "primary") : `fallback:${prevStatus ?? "unknown"}`;
    await input.hooks.onRoute?.({ attempt: attemptNo, backendId: spec.id, model: spec.model, reason });

    const startedAt = new Date();
    const t0 = now();
    const base = { attempt: attemptNo, backendId: spec.id, model: spec.model, reason, startedAt };

    if (input.forceFail?.includes(spec.id)) {
      await record({
        ...base,
        status: "forced_failure",
        errorDetail: "debug.force_fail",
        usage: undefined,
        costUsd: "0.00000000",
        latencyMs: Math.round(now() - t0),
        ttftMs: null,
      });
      prevStatus = "forced_failure";
      continue;
    }

    const controller = new AbortController();
    const onClientAbort = () => controller.abort(CLIENT_ABORT);
    input.clientSignal?.addEventListener("abort", onClientAbort, { once: true });
    const ttftTimer = setTimeout(() => controller.abort("timeout_ttft"), spec.ttftTimeoutMs);
    const totalTimer = setTimeout(() => controller.abort("timeout_total"), spec.totalTimeoutMs);

    let usage: UsageChunk | undefined;
    let firstContentAt: number | null = null;
    let consumerStop: BackendError | undefined; // quality signal from the consumer: stop, no fallback
    let consumerFailure: unknown; // unexpected throw from the consumer: a bug, surfaced to the route
    let iterator: AsyncIterator<StreamChunk> | undefined;
    let streamedChars = 0;
    // Some providers (Ollama) report usage only in the final chunk. If an attempt ends without it after
    // content was generated (abort, timeout, mid-stream error), record an estimate instead of a false zero.
    const effectiveUsage = (): UsageChunk | undefined =>
      usage ??
      (streamedChars > 0
        ? {
            type: "usage",
            promptTokens: estimateTokenCount(promptText),
            completionTokens: Math.ceil(streamedChars / 4),
            thinkingTokens: 0,
            estimated: true,
          }
        : undefined);
    const attemptCost = () =>
      costUsd(spec.price, effectiveUsage() ?? { promptTokens: 0, completionTokens: 0, thinkingTokens: 0 });

    try {
      const stream = input.backendFor(spec).stream({ ...input.request, signal: controller.signal });
      iterator = stream[Symbol.asyncIterator]();
      for (;;) {
        const next = await nextOrAbort(iterator, controller.signal);
        if (next.done) break;
        const chunk = next.value;
        if (chunk.type === "usage") {
          usage = chunk;
          continue;
        }
        if (firstContentAt === null) {
          firstContentAt = now();
          clearTimeout(ttftTimer);
        }
        streamedChars += chunk.type === "text" ? chunk.text.length : JSON.stringify(chunk.arguments ?? null).length;
        try {
          await input.hooks.onChunk(chunk, { commit: () => (committed = true), backend: spec });
        } catch (err) {
          if (err instanceof BackendError && !err.retryable) consumerStop = err;
          else consumerFailure = err;
          controller.abort("consumer_stop"); // stop generating upstream
          throw err;
        }
      }
      try {
        await input.hooks.onEnd?.({ backend: spec });
      } catch (err) {
        if (err instanceof BackendError && !err.retryable) consumerStop = err;
        else consumerFailure = err;
        throw err;
      }

      const attempt: AttemptResult = {
        ...base,
        status: "ok",
        errorDetail: null,
        usage: effectiveUsage(),
        costUsd: attemptCost(),
        latencyMs: Math.round(now() - t0),
        ttftMs: firstContentAt === null ? null : Math.round(firstContentAt - t0),
      };
      await record(attempt);
      return finish("ok", spec, firstContentAt === null ? null : Math.round(firstContentAt - runStart), null);
    } catch (err) {
      const latencyMs = Math.round(now() - t0);
      const ttftMs = firstContentAt === null ? null : Math.round(firstContentAt - t0);
      const failed = (status: AttemptStatus, errorDetail: string): AttemptResult => ({
        ...base,
        status,
        errorDetail,
        usage: effectiveUsage(),
        costUsd: attemptCost(),
        latencyMs,
        ttftMs,
      });

      if (input.clientSignal?.aborted) {
        await record(failed("aborted", "client disconnected"));
        return finish("client_aborted", null, null, { status: "aborted", message: "client disconnected" });
      }
      if (consumerStop) {
        await record(failed(consumerStop.status, consumerStop.message));
        // The backend did produce output (its tokens are billed), so it is reported as the one that served.
        return finish("stopped", spec, firstContentAt === null ? null : Math.round(firstContentAt - runStart), {
          status: consumerStop.status,
          message: consumerStop.message,
        });
      }
      if (consumerFailure !== undefined) {
        const message = consumerFailure instanceof Error ? consumerFailure.message : String(consumerFailure);
        await record(failed("upstream_error", `consumer error: ${message}`));
        throw consumerFailure;
      }

      const { status, message } = classify(err, controller.signal);
      if (committed) {
        // Content already reached the client: report it in-stream, no silent retry (docs/01 §2).
        await record(failed("mid_stream_error", `${status}: ${message}`));
        return finish("partial_error", spec, firstContentAt === null ? null : Math.round(firstContentAt - runStart), {
          status: "mid_stream_error",
          message: `${status}: ${message}`,
        });
      }
      await record(failed(status, message));
      prevStatus = status; // fall back to the next candidate
    } finally {
      clearTimeout(ttftTimer);
      clearTimeout(totalTimer);
      input.clientSignal?.removeEventListener("abort", onClientAbort);
      // Close the provider stream if it is still open (aborted, failed or stopped early).
      if (iterator?.return) void iterator.return().catch(() => undefined);
    }
  }

  const last = attempts.at(-1);
  return finish("all_backends_failed", null, null, {
    status: last?.status ?? "upstream_error",
    message: last
      ? `all ${attempts.length} candidates failed; last: ${last.errorDetail ?? last.status}`
      : "no candidates",
  });
}

// Totals across all attempts of a request (failed attempts that consumed tokens still count, docs/03 §5).
export function totals(attempts: readonly AttemptResult[]) {
  const sum = (pick: (u: UsageChunk) => number) => attempts.reduce((s, a) => s + (a.usage ? pick(a.usage) : 0), 0);
  const promptTokens = sum((u) => u.promptTokens);
  const completionTokens = sum((u) => u.completionTokens);
  const thinkingTokens = sum((u) => u.thinkingTokens);
  return {
    promptTokens,
    completionTokens,
    thinkingTokens,
    totalTokens: promptTokens + completionTokens + thinkingTokens,
    estimated: attempts.some((a) => a.usage?.estimated),
    costUsd: sumUsd(attempts.map((a) => a.costUsd)),
  };
}

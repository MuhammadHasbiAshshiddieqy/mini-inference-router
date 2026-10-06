import { ChatRequestSchema, type ChatRequest, type ChatResponse, type DoneEvent, type Outcome } from "@mir/shared";
import { Hono, type Context } from "hono";
import type { Pool } from "pg";
import type { Logger } from "pino";
import type { BackendRegistry } from "../backends/registry.ts";
import type { ChatTurn, GenerateRequest } from "../backends/types.ts";
import type { Env } from "../config/env.ts";
import { admit, settle, type Admission } from "../http/admission.ts";
import { AppError } from "../http/errors.ts";
import { openEventStream, type SendEvent } from "../http/sse.ts";
import type { AppEnv } from "../http/types.ts";
import { insertAttempt } from "../metering/requests.ts";
import { estimateTokens } from "../quota/quota.ts";
import { execute, totals, type AttemptResult, type ExecuteResult } from "../router/execute.ts";
import { plan, type Plan } from "../router/plan.ts";

// POST /v1/chat (docs/03 §2–§4): admit (validate → plan → reserve) → route with fallback → stream → settle → done.
// SSE by default; `"stream": false` returns one JSON object with the same information.

export type ChatDeps = {
  env: Env;
  getPool: () => Pool;
  registry: BackendRegistry;
  // Keeps the final metering write alive after the response closed (Vercel `waitUntil`, wired in Phase 9).
  waitUntil?: (promise: Promise<unknown>) => void;
  heartbeatMs?: number;
};

type Sink = {
  streaming: boolean; // true: content is forwarded as it arrives, so the first token commits the attempt
  send: SendEvent;
  onText: (text: string) => Promise<void>;
  onToolCall: (name: string, args: unknown) => Promise<void>;
  onNewAttempt: () => void;
};

type ChatRun = {
  result: ExecuteResult | undefined; // undefined when the run crashed
  outcome: Outcome;
  errorCode: string | null;
  errorMessage: string | null;
  done: DoneEvent;
};

function toGenerateRequest(body: ChatRequest, maxOutputTokens: number): Omit<GenerateRequest, "signal"> {
  const system = body.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const messages = body.messages.filter((m): m is ChatTurn => m.role !== "system");
  return {
    ...(system ? { system } : {}),
    messages,
    maxOutputTokens,
    ...(body.tools ? { tools: body.tools } : {}),
    mock: { latencyMs: body.debug?.mock_latency_ms, fail: body.debug?.mock_fail },
  };
}

async function recordAttempt(pool: Pool, log: Logger, requestId: string, a: AttemptResult): Promise<void> {
  try {
    await insertAttempt(pool, {
      requestId,
      attemptNo: a.attempt,
      backendId: a.backendId,
      model: a.model,
      reason: a.reason,
      status: a.status,
      errorDetail: a.errorDetail,
      promptTokens: a.usage?.promptTokens ?? null,
      completionTokens: a.usage?.completionTokens ?? null,
      thinkingTokens: a.usage?.thinkingTokens ?? null,
      costUsd: a.costUsd,
      latencyMs: a.latencyMs,
      ttftMs: a.ttftMs,
      startedAt: a.startedAt,
    });
  } catch (err) {
    log.error({ err, attempt: a.attempt }, "failed to record route attempt");
  }
}

function outcomeOf(result: ExecuteResult): { outcome: Outcome; errorCode: string | null } {
  switch (result.outcome) {
    case "ok":
      return { outcome: result.fallbackFired ? "ok_after_fallback" : "ok", errorCode: null };
    case "partial_error":
      return { outcome: "partial_error", errorCode: "mid_stream_error" };
    case "all_backends_failed":
      return { outcome: "all_backends_failed", errorCode: "all_backends_failed" };
    case "client_aborted":
      return { outcome: "client_aborted", errorCode: null };
    case "stopped": // chat has no quality gate; only the support assistant stops runs
      return { outcome: "internal_error", errorCode: "internal_error" };
  }
}

async function runChat(
  c: Context<AppEnv>,
  deps: ChatDeps,
  admission: Admission<ChatRequest>,
  routing: Plan,
  sink: Sink,
  clientSignal: AbortSignal | undefined,
): Promise<ChatRun> {
  const pool = deps.getPool();
  const log = c.get("logger");
  const attempts: AttemptResult[] = [];
  const runStart = performance.now();

  let result: ExecuteResult | undefined;
  let crash: unknown;
  try {
    result = await execute({
      candidates: routing.candidates,
      backendFor: (spec) => {
        const backend = deps.registry.get(spec.id);
        if (!backend) throw new Error(`backend ${spec.id} is planned but not registered`);
        return backend;
      },
      request: toGenerateRequest(admission.body, admission.maxOutputTokens),
      logger: log,
      ...(clientSignal ? { clientSignal } : {}),
      ...(admission.body.debug?.force_fail ? { forceFail: admission.body.debug.force_fail } : {}),
      hooks: {
        onRoute: async (e) => {
          sink.onNewAttempt();
          await sink.send("route", { attempt: e.attempt, backend_id: e.backendId, model: e.model, reason: e.reason });
        },
        onAttemptFailed: (e) =>
          sink.send("attempt_failed", {
            attempt: e.attempt,
            backend_id: e.backendId,
            status: e.status,
            error: e.error,
            latency_ms: e.latencyMs,
          }),
        onAttemptDone: async (a) => {
          attempts.push(a);
          await recordAttempt(pool, log, admission.start.id, a);
        },
        onChunk: async (chunk, ctx) => {
          if (sink.streaming) ctx.commit(); // the chat route forwards every token immediately
          if (chunk.type === "text") await sink.onText(chunk.text);
          else await sink.onToolCall(chunk.name, chunk.arguments);
        },
      },
    });
  } catch (err) {
    crash = err;
    log.error({ err }, "chat run crashed");
  }

  const sum = totals(result?.attempts ?? attempts);
  const { outcome, errorCode } = result
    ? outcomeOf(result)
    : { outcome: "internal_error" as const, errorCode: "internal_error" };
  const ttftMs = result?.ttftMs == null ? null : Math.round(runStart - admission.startedAt + result.ttftMs);

  // Metering is written BEFORE `done` is sent (docs/12 §1); waitUntil keeps it alive if the client left.
  const finalizing = settle(pool, c, admission, {
    outcome,
    servedBackendId: result?.servedBy?.backendId ?? null,
    servedModel: result?.servedBy?.model ?? null,
    fallbackFired: result?.fallbackFired ?? attempts.length > 1,
    escalated: false,
    attemptsCount: (result?.attempts ?? attempts).length,
    promptTokens: sum.promptTokens,
    completionTokens: sum.completionTokens,
    thinkingTokens: sum.thinkingTokens,
    totalTokens: sum.totalTokens,
    tokensEstimated: sum.estimated,
    costUsd: sum.costUsd,
    ttftMs,
    errorCode,
  });
  deps.waitUntil?.(finalizing);
  const { quota, latencyMs } = await finalizing;

  return {
    result,
    outcome,
    errorCode,
    errorMessage: crash !== undefined ? "Internal error while generating the answer" : (result?.error?.message ?? null),
    done: {
      outcome,
      served_by: result?.servedBy ? { backend_id: result.servedBy.backendId, model: result.servedBy.model } : null,
      fallback_fired: result?.fallbackFired ?? attempts.length > 1,
      escalated: false,
      usage: {
        prompt_tokens: sum.promptTokens,
        completion_tokens: sum.completionTokens,
        thinking_tokens: sum.thinkingTokens,
        total_tokens: sum.totalTokens,
        estimated: sum.estimated,
      },
      latency_ms: latencyMs,
      ttft_ms: ttftMs,
      cost_usd: Number(sum.costUsd),
      quota,
      decisions: routing.decisions,
    },
  };
}

export function chatRoutes(deps: ChatDeps) {
  return new Hono<AppEnv>().post("/chat", async (c) => {
    let routing: Plan | undefined;
    const admission = await admit(c, {
      db: deps.getPool(),
      profile: deps.env.PROFILE,
      endpoint: "chat",
      schema: ChatRequestSchema,
      estimatePromptTokens: (body) => estimateTokens(body.messages.map((m) => m.content).join("\n")),
      precheck: (body, tenant) => {
        if (!body.messages.some((m) => m.role !== "system")) {
          throw new AppError("invalid_request", 400, "messages must contain at least one user or assistant message");
        }
        routing = plan({
          profileBackends: deps.registry.backends.map((b) => b.spec),
          allowedBackends: tenant.allowedBackends,
          hasTools: Boolean(body.tools?.length),
        });
      },
    });
    if (!routing) throw new AppError("internal_error", 500, "routing plan missing after admission");
    const planned = routing;
    const log = c.get("logger");
    if (planned.decisions.length > 0) log.info({ decisions: planned.decisions }, "routing plan");

    if (admission.body.stream === false) {
      let answer = "";
      let toolCalls: { name: string; arguments: unknown }[] = [];
      const run = await runChat(
        c,
        deps,
        admission,
        planned,
        {
          streaming: false, // nothing reaches the client before the end, so fallback stays possible throughout
          send: async () => undefined,
          onText: async (t) => void (answer += t),
          onToolCall: async (name, args) => void toolCalls.push({ name, arguments: args }),
          onNewAttempt: () => {
            answer = ""; // discard partial output of a failed attempt
            toolCalls = [];
          },
        },
        c.req.raw.signal,
      );
      const attempts = (run.result?.attempts ?? []).map((a) => ({
        attempt: a.attempt,
        backend_id: a.backendId,
        model: a.model,
        reason: a.reason,
        status: a.status,
        error: a.errorDetail,
        latency_ms: a.latencyMs,
      }));
      if (run.outcome === "all_backends_failed") {
        throw new AppError("all_backends_failed", 502, run.errorMessage ?? "All backends failed", { attempts });
      }
      if (run.outcome === "internal_error") throw new AppError("internal_error", 500, "Internal error");
      const { escalated: _escalated, ...done } = run.done;
      const body: ChatResponse = {
        request_id: admission.start.id,
        ...done,
        answer,
        tool_calls: toolCalls,
        attempts,
      };
      return c.json(body);
    }

    return openEventStream(
      c,
      async ({ send, signal }) => {
        await send("meta", {
          request_id: admission.start.id,
          tenant: admission.tenant.id,
          endpoint: "chat",
          profile: deps.env.PROFILE,
        });
        const run = await runChat(
          c,
          deps,
          admission,
          planned,
          {
            streaming: true,
            send,
            onText: (text) => send("token", { text }),
            onToolCall: (name, args) => send("tool_call", { name, arguments: args }),
            onNewAttempt: () => undefined,
          },
          signal,
        );
        if (
          run.outcome === "partial_error" ||
          run.outcome === "all_backends_failed" ||
          run.outcome === "internal_error"
        ) {
          await send("error", {
            code: run.outcome === "partial_error" ? "mid_stream_error" : run.outcome,
            message: run.errorMessage ?? run.outcome,
          });
        }
        await send("done", run.done);
      },
      deps.heartbeatMs ? { heartbeatMs: deps.heartbeatMs } : {},
    );
  });
}

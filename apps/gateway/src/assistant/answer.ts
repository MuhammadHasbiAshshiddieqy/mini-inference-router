import type {
  ConfidenceLevel,
  DoneEvent,
  IntentEventData,
  Outcome,
  RefusalReason,
  SupportLabel,
  SupportRequest,
} from "@mir/shared";
import type { Context } from "hono";
import type { Pool } from "pg";
import type { BackendRegistry } from "../backends/registry.ts";
import { BackendError } from "../backends/types.ts";
import type { Env } from "../config/env.ts";
import type { Embedder } from "../embeddings/types.ts";
import { settle, type Admission } from "../http/admission.ts";
import { AppError } from "../http/errors.ts";
import type { SendEvent } from "../http/sse.ts";
import type { AppEnv } from "../http/types.ts";
import { recordAttempt } from "../metering/attempts.ts";
import { execute, totals, type AttemptResult, type ExecuteResult } from "../router/execute.ts";
import type { Plan } from "../router/plan.ts";
import {
  REFUSAL_MESSAGE,
  confidenceScore,
  decideOnHeader,
  decideOnInvalidOutput,
  preGate,
  type Decision,
  type Thresholds,
} from "./confidence.ts";
import { InvalidOutputError, SupportOutputParser } from "./parse.ts";
import { FORMAT_REMINDER, PROMPT_V1, buildMessages } from "./prompt.ts";
import { retrieve, type Retrieval } from "./retrieve.ts";

// Support assistant orchestration (docs/05 §1, docs/04 §6):
// retrieve → pre-gate (refuse without an LLM call) → route with fallback → parse the INTENT header →
// decide (answer | refuse | escalate once) → stream the body → settle metering → done.
//
// Escalation (quality) is not fallback (failure): it re-runs ONCE on the backend that produced the bad
// header, with thinking "low" and a format reminder; if that attempt fails as a backend error, normal
// fallback continues from there. Nothing is committed to the client before the header is accepted, so a
// failure during the header phase can still fall back.

export type SupportDeps = {
  env: Env;
  getPool: () => Pool;
  registry: BackendRegistry;
  embedder: Embedder;
  embeddingModel: string;
  thresholds: Thresholds;
  waitUntil?: (promise: Promise<unknown>) => void;
};

export type SupportSink = {
  streaming: boolean; // SSE: forward the body as it arrives (commits the attempt); JSON: buffer until the end
  send: SendEvent;
  onBody: (text: string) => Promise<void>;
  onNewAttempt: () => void; // discard buffered body text of a failed attempt (JSON mode)
};

export type SupportRun = {
  outcome: Outcome;
  retrieval: Retrieval | undefined;
  refusal: { reason: RefusalReason; message: string } | undefined;
  intent: IntentEventData | undefined;
  confidence: { level: ConfidenceLevel; score: number } | undefined;
  llmIntent: SupportLabel | null;
  attempts: AttemptResult[];
  errorCode: string | null;
  errorMessage: string | null;
  done: DoneEvent;
};

// Why the consumer stopped an attempt. Stops are quality decisions, so they carry a non-retryable error.
type Pending =
  | { kind: "invalid"; message: string }
  | { kind: "escalate"; why: "intent_disagreement" }
  | { kind: "refuse"; decision: Extract<Decision, { action: "refuse" }> };

const stop = (status: "ok" | "invalid_output", message: string) =>
  new BackendError(status, message, { retryable: false });

export async function runSupport(
  c: Context<AppEnv>,
  deps: SupportDeps,
  admission: Admission<SupportRequest>,
  routing: Plan,
  sink: SupportSink,
  clientSignal: AbortSignal | undefined,
): Promise<SupportRun> {
  const pool = deps.getPool();
  const log = c.get("logger");
  const body = admission.body;
  const t = deps.thresholds;
  const attempts: AttemptResult[] = [];
  let retrieval: Retrieval | undefined;
  let refusal: SupportRun["refusal"];
  let intent: IntentEventData | undefined;
  let confidence: SupportRun["confidence"];
  let llmIntent: SupportLabel | null = null;
  let finalIntent: SupportLabel | null = null;
  let escalated = false;
  let fallbackFired = false;
  let servedBy: ExecuteResult["servedBy"] = null;
  let firstBodyAt: number | null = null;
  let outcome: Outcome = "internal_error";
  let errorCode: string | null = null;
  let errorMessage: string | null = null;

  const refuse = async (reason: RefusalReason) => {
    refusal = { reason, message: REFUSAL_MESSAGE };
    await sink.send("refusal", refusal);
    outcome = "refused";
  };

  try {
    retrieval = await retrieve({
      db: pool,
      embedder: deps.embedder,
      embeddingModel: deps.embeddingModel,
      query: body.message,
      mode: deps.env.RETRIEVAL_MODE,
      topK: deps.env.RETRIEVAL_TOP_K,
      candidates: deps.env.RETRIEVAL_CANDIDATES,
      rrfK: deps.env.RRF_K,
      lexicalFallback: deps.env.RETRIEVAL_LEXICAL_FALLBACK,
      ...(body.debug?.force_embedding_fail ? { forceEmbeddingFail: true } : {}),
      ...(clientSignal ? { signal: clientSignal } : {}),
      logger: log,
    });
    const signals = retrieval.signals;
    await sink.send("retrieval", {
      mode: retrieval.mode,
      entries: retrieval.entries.map(({ response: _full, ...entry }) => entry),
      knn_intent: signals.knnIntent,
      vote_share: signals.voteShare,
      top1_similarity: signals.top1Similarity,
    });

    const intentData = (llm: SupportLabel, final: SupportLabel, level: ConfidenceLevel): IntentEventData => {
      const agree = llm === signals.knnIntent;
      const score = confidenceScore(signals, agree, t);
      confidence = { level, score };
      return {
        llm_intent: llm,
        final_intent: final,
        confidence: {
          level,
          score,
          signals: {
            top1_similarity: signals.top1Similarity,
            vote_share: signals.voteShare,
            knn_intent: signals.knnIntent,
            llm_intent: llm,
            agree,
            escalated,
            retrieval_mode: signals.mode,
            thresholds: { T_oos: t.T_oos, T_high: t.T_high },
          },
        },
      };
    };

    const gate = preGate(signals, t);
    if (gate?.action === "refuse") {
      confidence = { level: "low", score: confidenceScore(signals, false, t) };
      await refuse(gate.reason);
    } else {
      const references = retrieval.entries.map((e) => ({
        intent: e.intent,
        similarity: retrieval!.mode === "lexical_fallback" ? e.trgm_sim : e.dense_sim,
        instruction: e.instruction,
        response: e.response,
      }));
      const top1 = retrieval.entries[0]!;
      let candidates = routing.candidates;
      let firstReason = "primary";

      for (let run = 0; run < 2; run++) {
        let parser = new SupportOutputParser();
        let decision: Extract<Decision, { action: "answer" }> | undefined;
        let pending: Pending | undefined;
        let committed = false;

        const handleHeader = (label: SupportLabel) => {
          llmIntent = label;
          const d = decideOnHeader(label, signals, escalated, t);
          if (d.action === "answer") {
            decision = d;
            return;
          }
          if (d.action === "escalate") {
            pending = { kind: "escalate", why: "intent_disagreement" };
            throw stop(
              "ok",
              `header accepted; escalating on intent disagreement (llm ${label}, knn ${signals.knnIntent})`,
            );
          }
          if (d.action === "refuse") {
            pending = { kind: "refuse", decision: d };
            throw stop("ok", `header accepted; refusal ${d.reason}`);
          }
        };
        const invalid = (err: InvalidOutputError) => {
          pending = { kind: "invalid", message: err.message };
          return stop("invalid_output", err.message);
        };

        const result = await execute({
          candidates,
          backendFor: (spec) => {
            const backend = deps.registry.get(spec.id);
            if (!backend) throw new Error(`backend ${spec.id} is planned but not registered`);
            return backend;
          },
          request: {
            system: escalated ? `${PROMPT_V1}\n\n${FORMAT_REMINDER}` : PROMPT_V1,
            messages: buildMessages(references, body.message),
            maxOutputTokens: admission.maxOutputTokens,
            ...(escalated ? { overrides: { thinkingLevel: "low" as const } } : {}),
            // The mock answers with a valid header and the top-1 KB answer: degraded but grounded.
            mock: {
              latencyMs: body.debug?.mock_latency_ms,
              fail: body.debug?.mock_fail,
              reply: `INTENT: ${signals.knnIntent}\n---\n${top1.response}`,
            },
          },
          logger: log,
          firstReason,
          firstAttemptNo: attempts.length + 1,
          ...(clientSignal ? { clientSignal } : {}),
          ...(body.debug?.force_fail ? { forceFail: body.debug.force_fail } : {}),
          hooks: {
            onRoute: async (e) => {
              parser = new SupportOutputParser();
              decision = undefined;
              pending = undefined;
              sink.onNewAttempt();
              await sink.send("route", {
                attempt: e.attempt,
                backend_id: e.backendId,
                model: e.model,
                reason: e.reason,
              });
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
              if (chunk.type !== "text") return; // the support assistant does not use tools
              let events;
              try {
                events = parser.push(chunk.text);
              } catch (err) {
                if (err instanceof InvalidOutputError) throw invalid(err);
                throw err;
              }
              for (const ev of events) {
                if (ev.type === "header") {
                  handleHeader(ev.label);
                  continue;
                }
                if (!decision) continue;
                if (!committed) {
                  committed = true;
                  if (sink.streaming) ctx.commit();
                  firstBodyAt ??= performance.now();
                  intent = intentData(llmIntent!, decision.finalIntent, decision.level);
                  finalIntent = decision.finalIntent;
                  await sink.send("intent", intent);
                }
                await sink.onBody(ev.text);
              }
            },
            onEnd: () => {
              let late;
              try {
                late = parser.finish();
              } catch (err) {
                if (err instanceof InvalidOutputError) throw invalid(err);
                throw err;
              }
              for (const ev of late) if (ev.type === "header") handleHeader(ev.label);
            },
          },
        });
        fallbackFired ||= result.fallbackFired;
        servedBy = result.servedBy ?? servedBy;

        if (result.outcome === "ok") {
          outcome = fallbackFired ? "ok_after_fallback" : "ok";
          break;
        }
        if (result.outcome === "stopped" && pending) {
          const p: Pending = pending;
          if (p.kind === "refuse") {
            intent = intentData(llmIntent!, p.decision.finalIntent ?? llmIntent!, "low");
            finalIntent = p.decision.finalIntent;
            await sink.send("intent", intent);
            await refuse(p.decision.reason);
            break;
          }
          const why = p.kind === "invalid" ? "invalid_output" : p.why;
          const next = p.kind === "invalid" ? decideOnInvalidOutput(escalated) : ({ action: "escalate", why } as const);
          if (next.action === "refuse") {
            confidence = { level: "low", score: confidenceScore(signals, false, t) };
            await refuse(next.reason);
            break;
          }
          // Escalate once: same backend first, then the rest of the plan after it.
          escalated = true;
          const from = routing.candidates.findIndex((s) => s.id === result.servedBy?.backendId);
          candidates = routing.candidates.slice(Math.max(0, from));
          firstReason = `escalation:${why}`;
          continue;
        }
        if (result.outcome === "partial_error") {
          outcome = "partial_error";
          errorCode = "mid_stream_error";
          errorMessage = result.error?.message ?? "the backend failed mid-stream";
          await sink.send("error", { code: "mid_stream_error", message: errorMessage });
        } else if (result.outcome === "all_backends_failed") {
          outcome = "all_backends_failed";
          errorCode = "all_backends_failed";
          errorMessage = result.error?.message ?? "all backends failed";
          await sink.send("error", { code: "all_backends_failed", message: errorMessage });
        } else if (result.outcome === "client_aborted") {
          outcome = "client_aborted";
        } else {
          outcome = "internal_error";
          errorCode = "internal_error";
        }
        break;
      }
    }
  } catch (err) {
    log.error({ err }, "support run failed");
    outcome = "internal_error";
    errorCode = err instanceof AppError ? err.code : "internal_error";
    errorMessage = err instanceof AppError ? err.message : "Internal error while answering";
    await sink
      .send("error", {
        code: err instanceof AppError ? err.code : "internal_error",
        message: errorMessage,
      })
      .catch(() => undefined);
  }

  const sum = totals(attempts);
  const ttftMs = firstBodyAt === null ? null : Math.round(firstBodyAt - admission.startedAt);
  const finalizing = settle(pool, c, admission, {
    outcome,
    servedBackendId: servedBy?.backendId ?? null,
    servedModel: servedBy?.model ?? null,
    fallbackFired,
    escalated,
    attemptsCount: attempts.length,
    promptTokens: sum.promptTokens,
    completionTokens: sum.completionTokens,
    thinkingTokens: sum.thinkingTokens,
    totalTokens: sum.totalTokens,
    tokensEstimated: sum.estimated,
    costUsd: sum.costUsd,
    ttftMs,
    errorCode,
    intent: finalIntent,
    confidenceLevel: confidence?.level ?? null,
    confidenceScore: confidence?.score ?? null,
    retrievedIds: retrieval?.entries.map((e) => e.id) ?? null,
    retrievalMode: retrieval?.mode ?? null,
  });
  deps.waitUntil?.(finalizing);
  const { quota, latencyMs } = await finalizing;

  return {
    outcome,
    retrieval,
    refusal,
    intent,
    confidence,
    llmIntent,
    attempts,
    errorCode,
    errorMessage,
    done: {
      outcome,
      served_by: servedBy ? { backend_id: servedBy.backendId, model: servedBy.model } : null,
      fallback_fired: fallbackFired,
      escalated,
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

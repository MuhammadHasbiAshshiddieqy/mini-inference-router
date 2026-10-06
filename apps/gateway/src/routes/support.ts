import { SupportRequestSchema, type SupportResponse } from "@mir/shared";
import { Hono } from "hono";
import type { Pool } from "pg";
import { runSupport, type SupportDeps } from "../assistant/answer.ts";
import { estimateSupportPromptTokens } from "../assistant/prompt.ts";
import type { BackendRegistry } from "../backends/registry.ts";
import type { Env } from "../config/env.ts";
import type { ThresholdsResult } from "../config/thresholds.ts";
import type { Embedder } from "../embeddings/types.ts";
import { admit } from "../http/admission.ts";
import { AppError } from "../http/errors.ts";
import { openEventStream } from "../http/sse.ts";
import type { AppEnv } from "../http/types.ts";
import { plan, type Plan } from "../router/plan.ts";

// POST /v1/support/answer (docs/05): SSE by default, one JSON object with `"stream": false`.

export type SupportRouteDeps = {
  env: Env;
  getPool: () => Pool;
  registry: BackendRegistry;
  embedder: Embedder;
  embeddingModel: string;
  thresholds: ThresholdsResult;
  waitUntil?: (promise: Promise<unknown>) => void;
  heartbeatMs?: number;
};

export function supportRoutes(deps: SupportRouteDeps) {
  return new Hono<AppEnv>().post("/support/answer", async (c) => {
    let routing: Plan | undefined;
    const admission = await admit(c, {
      db: deps.getPool(),
      profile: deps.env.PROFILE,
      endpoint: "support",
      schema: SupportRequestSchema,
      estimatePromptTokens: (body) => estimateSupportPromptTokens(body.message, deps.env.RETRIEVAL_TOP_K),
      precheck: (_body, tenant) => {
        if (!deps.thresholds.ok) {
          throw new AppError(
            "assistant_unavailable",
            503,
            `Support assistant is not calibrated for ${deps.embeddingModel}: missing ${deps.thresholds.missing.join(", ")}. Run pnpm calibrate.`,
          );
        }
        routing = plan({
          profileBackends: deps.registry.backends.map((b) => b.spec),
          allowedBackends: tenant.allowedBackends,
          hasTools: false,
        });
      },
    });
    if (!routing || !deps.thresholds.ok) throw new AppError("internal_error", 500, "support admission incomplete");
    const run = { ...deps, thresholds: deps.thresholds.thresholds } satisfies SupportDeps;
    const planned = routing;

    if (admission.body.stream === false) {
      let answer = "";
      const result = await runSupport(
        c,
        run,
        admission,
        planned,
        {
          streaming: false,
          send: async () => undefined,
          onBody: async (t) => void (answer += t),
          onNewAttempt: () => void (answer = ""),
        },
        c.req.raw.signal,
      );
      if (result.outcome === "all_backends_failed") {
        throw new AppError("all_backends_failed", 502, result.errorMessage ?? "All backends failed", {
          attempts: result.attempts.map((a) => ({
            attempt: a.attempt,
            backend_id: a.backendId,
            reason: a.reason,
            status: a.status,
          })),
        });
      }
      if (result.outcome === "internal_error") {
        throw new AppError(
          (result.errorCode as "assistant_unavailable" | "embedding_unavailable" | null) ?? "internal_error",
          result.errorCode === "assistant_unavailable" || result.errorCode === "embedding_unavailable" ? 503 : 500,
          result.errorMessage ?? "Internal error",
        );
      }
      const body: SupportResponse = {
        request_id: admission.start.id,
        ...result.done,
        answer: result.refusal ? result.refusal.message : answer,
        refused: result.refusal !== undefined,
        refusal_reason: result.refusal?.reason ?? null,
        intent: {
          final:
            result.intent?.final_intent ?? (result.refusal?.reason === "model_out_of_scope" ? "out_of_scope" : null),
          llm: result.llmIntent,
          knn: result.retrieval?.signals.knnIntent ?? null,
        },
        confidence: result.intent?.confidence ?? null,
        retrieval_mode: result.retrieval?.mode ?? "dense",
        retrieved: (result.retrieval?.entries ?? []).map(({ response: _full, ...entry }) => entry),
      };
      return c.json(body);
    }

    return openEventStream(
      c,
      async ({ send, signal }) => {
        await send("meta", {
          request_id: admission.start.id,
          tenant: admission.tenant.id,
          endpoint: "support",
          profile: deps.env.PROFILE,
        });
        const result = await runSupport(
          c,
          run,
          admission,
          planned,
          { streaming: true, send, onBody: (text) => send("token", { text }), onNewAttempt: () => undefined },
          signal,
        );
        await send("done", result.done);
      },
      deps.heartbeatMs ? { heartbeatMs: deps.heartbeatMs } : {},
    );
  });
}

import type { Logger } from "pino";
import type { Queryable } from "../quota/quota.ts";
import type { AttemptResult } from "../router/execute.ts";
import { insertAttempt } from "./requests.ts";

// One route_attempts row per backend attempt (docs/01 §4), written as each attempt finishes so a crash midway
// still leaves the attempts that happened. A failed write is logged, never surfaced to the client.
export async function recordAttempt(db: Queryable, log: Logger, requestId: string, a: AttemptResult): Promise<void> {
  try {
    await insertAttempt(db, {
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

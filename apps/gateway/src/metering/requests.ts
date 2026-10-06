import type { AttemptStatus, ConfidenceLevel, Endpoint, Outcome, Profile, RetrievalMode } from "@mir/shared";
import type { Logger } from "pino";
import type { Queryable } from "../quota/quota.ts";

// Metering (docs/03 §6): one `requests` row per request with a known tenant, one `route_attempts` row per
// backend attempt. The row is inserted as `in_progress` at admission and finalized before `done` is sent,
// so a request that crashes midway stays visible.

export type RequestStart = { id: string; tenantId: string; endpoint: Endpoint; profile: Profile };

export async function insertRequest(db: Queryable, start: RequestStart): Promise<void> {
  await db.query(
    `INSERT INTO requests (id, tenant_id, endpoint, profile, outcome) VALUES ($1, $2, $3, $4, 'in_progress')`,
    [start.id, start.tenantId, start.endpoint, start.profile],
  );
}

// Rejected before any backend work (invalid body, policy, quota). Best effort: a failure here is logged and
// must not replace the error the client is about to receive.
export async function recordRejectedRequest(
  db: Queryable,
  log: Logger,
  start: RequestStart,
  outcome: Extract<Outcome, "invalid_request" | "quota_exceeded">,
  errorCode: string,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO requests (id, tenant_id, endpoint, profile, outcome, error_code, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, 0)`,
      [start.id, start.tenantId, start.endpoint, start.profile, outcome, errorCode],
    );
  } catch (err) {
    log.error({ err, outcome, error_code: errorCode }, "failed to record rejected request");
  }
}

export type RequestFinal = {
  outcome: Outcome;
  servedBackendId: string | null;
  servedModel: string | null;
  fallbackFired: boolean;
  escalated: boolean;
  attemptsCount: number;
  promptTokens: number;
  completionTokens: number;
  thinkingTokens: number;
  totalTokens: number;
  tokensEstimated: boolean;
  costUsd: string; // decimal string, numeric(12,8)
  latencyMs: number;
  ttftMs: number | null;
  errorCode?: string | null;
  intent?: string | null;
  confidenceLevel?: ConfidenceLevel | null;
  confidenceScore?: number | null;
  retrievedIds?: string[] | null;
  retrievalMode?: RetrievalMode | null;
};

export async function finalizeRequest(db: Queryable, id: string, f: RequestFinal): Promise<void> {
  await db.query(
    `UPDATE requests SET outcome = $2, served_backend_id = $3, served_model = $4, fallback_fired = $5, escalated = $6,
       attempts_count = $7, prompt_tokens = $8, completion_tokens = $9, thinking_tokens = $10, total_tokens = $11,
       tokens_estimated = $12, cost_usd = $13, latency_ms = $14, ttft_ms = $15, error_code = $16, intent = $17,
       confidence_level = $18, confidence_score = $19, retrieved_ids = $20, retrieval_mode = $21
     WHERE id = $1`,
    [
      id,
      f.outcome,
      f.servedBackendId,
      f.servedModel,
      f.fallbackFired,
      f.escalated,
      f.attemptsCount,
      f.promptTokens,
      f.completionTokens,
      f.thinkingTokens,
      f.totalTokens,
      f.tokensEstimated,
      f.costUsd,
      f.latencyMs,
      f.ttftMs,
      f.errorCode ?? null,
      f.intent ?? null,
      f.confidenceLevel ?? null,
      f.confidenceScore ?? null,
      f.retrievedIds ?? null,
      f.retrievalMode ?? null,
    ],
  );
}

export type AttemptRecord = {
  requestId: string;
  attemptNo: number;
  backendId: string;
  model: string;
  reason: string; // 'primary' | 'fallback:<prev_status>' | 'escalation:<why>'
  status: AttemptStatus;
  errorDetail: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  thinkingTokens: number | null;
  costUsd: string;
  latencyMs: number;
  ttftMs: number | null;
  startedAt: Date;
};

export async function insertAttempt(db: Queryable, a: AttemptRecord): Promise<void> {
  await db.query(
    `INSERT INTO route_attempts (request_id, attempt_no, backend_id, model, reason, status, error_detail,
       prompt_tokens, completion_tokens, thinking_tokens, cost_usd, latency_ms, ttft_ms, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      a.requestId,
      a.attemptNo,
      a.backendId,
      a.model,
      a.reason,
      a.status,
      a.errorDetail,
      a.promptTokens,
      a.completionTokens,
      a.thinkingTokens,
      a.costUsd,
      a.latencyMs,
      a.ttftMs,
      a.startedAt,
    ],
  );
}

import { z } from "zod";
import { IntentSchema, SupportLabelSchema } from "./intents.ts";

// Enums and value shapes shared by the HTTP API, the SSE contract and the database (docs/03).

export const PROFILES = ["cloud", "local", "hybrid"] as const;
export const ProfileSchema = z.enum(PROFILES);
export type Profile = z.infer<typeof ProfileSchema>;

// Stable backend ids used in tenant policy and metering (docs/04 §3). Ids stay stable when model versions change.
export const BACKEND_IDS = ["gemini-3.5-flash", "gemini-3-flash", "ollama", "mock"] as const;
export const BackendIdSchema = z.enum(BACKEND_IDS);
export type BackendId = z.infer<typeof BackendIdSchema>;

export const ENDPOINTS = ["chat", "support"] as const;
export const EndpointSchema = z.enum(ENDPOINTS);
export type Endpoint = z.infer<typeof EndpointSchema>;

// `requests.outcome` (docs/03 §7).
export const OUTCOMES = [
  "ok",
  "ok_after_fallback",
  "refused",
  "quota_exceeded",
  "invalid_request",
  "all_backends_failed",
  "partial_error",
  "client_aborted",
  "internal_error",
  "in_progress",
] as const;
export const OutcomeSchema = z.enum(OUTCOMES);
export type Outcome = z.infer<typeof OutcomeSchema>;

// `route_attempts.status` (docs/03 §6).
export const ATTEMPT_STATUSES = [
  "ok",
  "timeout_ttft",
  "timeout_total",
  "rate_limited",
  "upstream_error",
  "network_error",
  "invalid_output",
  "forced_failure",
  "aborted",
  "mid_stream_error",
] as const;
export const AttemptStatusSchema = z.enum(ATTEMPT_STATUSES);
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;

// Error codes returned in `{ error: { code } }` and in SSE `error` events (docs/03 §7).
export const ERROR_CODES = [
  "invalid_request",
  "missing_api_key",
  "invalid_api_key",
  "tenant_disabled",
  "debug_not_allowed",
  "no_allowed_backend",
  "not_found",
  "payload_too_large",
  "unsupported_media_type",
  "tools_unsupported",
  "quota_exceeded",
  "all_backends_failed",
  "quota_unavailable",
  "embedding_unavailable",
  "internal_error",
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const RETRIEVAL_MODES = ["dense", "hybrid", "lexical_fallback"] as const;
export const RetrievalModeSchema = z.enum(RETRIEVAL_MODES);
export type RetrievalMode = z.infer<typeof RetrievalModeSchema>;

export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export const ConfidenceLevelSchema = z.enum(CONFIDENCE_LEVELS);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

// docs/05 §6.
export const REFUSAL_REASONS = [
  "low_retrieval_similarity",
  "model_out_of_scope",
  "intent_disagreement",
  "unusable_model_output",
] as const;
export const RefusalReasonSchema = z.enum(REFUSAL_REASONS);
export type RefusalReason = z.infer<typeof RefusalReasonSchema>;

export const ServedBySchema = z.object({
  backend_id: z.string(),
  model: z.string(),
});
export type ServedBy = z.infer<typeof ServedBySchema>;

const tokenCount = z.number().int().nonnegative();

export const UsageSchema = z.object({
  prompt_tokens: tokenCount,
  completion_tokens: tokenCount,
  thinking_tokens: tokenCount,
  total_tokens: tokenCount,
  estimated: z.boolean(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const QuotaStateSchema = z.object({
  limit: tokenCount,
  used: tokenCount,
  remaining: tokenCount,
});
export type QuotaState = z.infer<typeof QuotaStateSchema>;

// One retrieved KB entry. Scores that do not apply to the active mode are null (docs/03 §4).
export const RetrievedEntrySchema = z.object({
  id: z.string(),
  intent: IntentSchema,
  dense_sim: z.number().nullable(),
  trgm_sim: z.number().nullable(),
  rrf: z.number().nullable(),
  dense_rank: z.number().int().positive().nullable(),
  lex_rank: z.number().int().positive().nullable(),
  instruction: z.string(),
  response_preview: z.string(),
});
export type RetrievedEntry = z.infer<typeof RetrievedEntrySchema>;

// docs/05 §6: signals sent to the client for transparency.
export const ConfidenceSignalsSchema = z.object({
  top1_similarity: z.number(),
  vote_share: z.number().min(0).max(1),
  knn_intent: IntentSchema,
  llm_intent: SupportLabelSchema.nullable(),
  agree: z.boolean().nullable(),
  escalated: z.boolean(),
  retrieval_mode: RetrievalModeSchema,
  thresholds: z.object({ T_oos: z.number(), T_high: z.number() }),
});
export type ConfidenceSignals = z.infer<typeof ConfidenceSignalsSchema>;

export const ConfidenceSchema = z.object({
  level: ConfidenceLevelSchema,
  score: z.number().min(0).max(1),
  signals: ConfidenceSignalsSchema,
});
export type Confidence = z.infer<typeof ConfidenceSchema>;

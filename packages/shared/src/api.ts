import { z } from "zod";
import {
  AttemptStatusSchema,
  BackendIdSchema,
  ConfidenceSchema,
  EndpointSchema,
  ErrorCodeSchema,
  OutcomeSchema,
  QuotaStateSchema,
  RefusalReasonSchema,
  RetrievalModeSchema,
  RetrievedEntrySchema,
  ServedBySchema,
  UsageSchema,
} from "./domain.ts";
import { IntentSchema, SupportLabelSchema } from "./intents.ts";

// HTTP request and response DTOs (docs/03 §3, docs/05 §8).

export const CHAT_MAX_MESSAGES = 20;
export const CHAT_MAX_TOTAL_CHARS = 8000;
export const SUPPORT_MAX_MESSAGE_CHARS = 2000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 512;
// Absolute sanity bound; the effective cap is `tenant.max_output_tokens`, enforced by the gateway.
export const MAX_OUTPUT_TOKENS_LIMIT = 8192;

// Per-request debug overrides. Only honoured for tenants with `allow_debug` (else 403 debug_not_allowed).
export const DebugOptionsSchema = z.strictObject({
  force_fail: z.array(z.string().min(1)).max(10).optional(),
  mock_latency_ms: z.number().int().min(0).max(20_000).optional(),
  mock_fail: z.boolean().optional(),
  force_embedding_fail: z.boolean().optional(),
});
export type DebugOptions = z.infer<typeof DebugOptionsSchema>;

// Tool declaration passed through to tool-capable backends. The gateway never executes tools.
export const ToolDeclSchema = z.strictObject({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/, "tool name must be 1-64 chars: letters, digits, _ . -"),
  description: z.string().max(1024).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});
export type ToolDecl = z.infer<typeof ToolDeclSchema>;

const maxOutputTokens = z.number().int().min(1).max(MAX_OUTPUT_TOKENS_LIMIT);

export const ChatMessageSchema = z.strictObject({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestSchema = z.strictObject({
  messages: z
    .array(ChatMessageSchema)
    .min(1)
    .max(CHAT_MAX_MESSAGES)
    .refine((msgs) => msgs.reduce((sum, m) => sum + m.content.length, 0) <= CHAT_MAX_TOTAL_CHARS, {
      message: `total message content must be at most ${CHAT_MAX_TOTAL_CHARS} characters`,
    }),
  max_output_tokens: maxOutputTokens.optional(),
  tools: z.array(ToolDeclSchema).min(1).max(32).optional(),
  stream: z.boolean().optional(),
  debug: DebugOptionsSchema.optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const SupportRequestSchema = z.strictObject({
  message: z.string().trim().min(1).max(SUPPORT_MAX_MESSAGE_CHARS),
  max_output_tokens: maxOutputTokens.optional(),
  stream: z.boolean().optional(),
  debug: DebugOptionsSchema.optional(),
});
export type SupportRequest = z.infer<typeof SupportRequestSchema>;

// Every non-2xx JSON response has this shape.
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    request_id: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

const responseMetrics = {
  request_id: z.string(),
  outcome: OutcomeSchema,
  served_by: ServedBySchema.nullable(),
  fallback_fired: z.boolean(),
  usage: UsageSchema,
  latency_ms: z.number().int().nonnegative(),
  ttft_ms: z.number().int().nonnegative().nullable(),
  cost_usd: z.number().nonnegative(),
  quota: QuotaStateSchema,
};

// `POST /v1/chat` with `stream: false`.
export const ChatResponseSchema = z.object({
  ...responseMetrics,
  answer: z.string(),
  tool_calls: z.array(z.object({ name: z.string(), arguments: z.unknown() })),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

// `POST /v1/support/answer` with `stream: false` (docs/05 §8).
export const SupportResponseSchema = z.object({
  ...responseMetrics,
  answer: z.string(),
  refused: z.boolean(),
  refusal_reason: RefusalReasonSchema.nullable(),
  intent: z.object({
    final: SupportLabelSchema.nullable(),
    llm: SupportLabelSchema.nullable(),
    knn: IntentSchema.nullable(),
  }),
  confidence: ConfidenceSchema.nullable(),
  retrieval_mode: RetrievalModeSchema,
  retrieved: z.array(RetrievedEntrySchema),
  escalated: z.boolean(),
});
export type SupportResponse = z.infer<typeof SupportResponseSchema>;

// ---- Usage and admin views (docs/03 §3, docs/06) ----

const count = z.number().int().nonnegative();

export const TenantUsageSchema = z.object({
  requests: count,
  total_tokens: count,
  cost_usd: z.number().nonnegative(), // list-price equivalent ("est."), for display; stored exactly as numeric(12,8)
  fallback_count: count,
  outcomes: z.record(z.string(), count), // e.g. { ok: 12, refused: 2, quota_exceeded: 1 }
  last_request_at: z.string().nullable(),
});
export type TenantUsage = z.infer<typeof TenantUsageSchema>;

// GET /v1/usage: the calling tenant only.
export const UsageResponseSchema = z.object({
  tenant: z.object({ id: z.string(), name: z.string() }),
  quota: QuotaStateSchema,
  policy: z.object({
    allowed_backends: z.array(BackendIdSchema),
    allow_debug: z.boolean(),
    max_output_tokens: count,
  }),
  usage: TenantUsageSchema,
});
export type UsageResponse = z.infer<typeof UsageResponseSchema>;

// GET /admin/usage: every tenant.
export const AdminUsageResponseSchema = z.object({
  tenants: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      quota: QuotaStateSchema,
      usage: TenantUsageSchema,
    }),
  ),
});
export type AdminUsageResponse = z.infer<typeof AdminUsageResponseSchema>;

export const RequestRowSchema = z.object({
  id: z.string(),
  tenant_id: z.string().nullable(),
  endpoint: EndpointSchema,
  profile: z.string(),
  outcome: OutcomeSchema,
  served_backend_id: z.string().nullable(),
  served_model: z.string().nullable(),
  fallback_fired: z.boolean(),
  escalated: z.boolean(),
  attempts_count: count,
  prompt_tokens: count,
  completion_tokens: count,
  thinking_tokens: count,
  total_tokens: count,
  tokens_estimated: z.boolean(),
  cost_usd: z.string(), // exact decimal string from numeric(12,8)
  latency_ms: count.nullable(),
  ttft_ms: count.nullable(),
  intent: z.string().nullable(),
  confidence_level: z.string().nullable(),
  confidence_score: z.number().nullable(),
  retrieved_ids: z.array(z.string()).nullable(),
  retrieval_mode: z.string().nullable(),
  error_code: z.string().nullable(),
  created_at: z.string(),
});
export type RequestRow = z.infer<typeof RequestRowSchema>;

export const RouteAttemptRowSchema = z.object({
  attempt_no: z.number().int().positive(),
  backend_id: z.string(),
  model: z.string(),
  reason: z.string(),
  status: AttemptStatusSchema,
  error_detail: z.string().nullable(),
  prompt_tokens: count.nullable(),
  completion_tokens: count.nullable(),
  thinking_tokens: count.nullable(),
  cost_usd: z.string(),
  latency_ms: count.nullable(),
  ttft_ms: count.nullable(),
  started_at: z.string(),
});
export type RouteAttemptRow = z.infer<typeof RouteAttemptRowSchema>;

// GET /admin/requests?tenant=&outcome=&limit=
export const AdminRequestsQuerySchema = z.strictObject({
  tenant: z.string().min(1).optional(),
  outcome: OutcomeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const AdminRequestsResponseSchema = z.object({ requests: z.array(RequestRowSchema) });
export type AdminRequestsResponse = z.infer<typeof AdminRequestsResponseSchema>;

// GET /admin/requests/:id — the fallback decision record (R9).
export const AdminRequestDetailSchema = z.object({
  request: RequestRowSchema,
  attempts: z.array(RouteAttemptRowSchema),
});
export type AdminRequestDetail = z.infer<typeof AdminRequestDetailSchema>;

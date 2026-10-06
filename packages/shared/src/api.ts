import { z } from "zod";
import {
  ConfidenceSchema,
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

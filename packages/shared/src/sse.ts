import { z } from "zod";
import {
  AttemptStatusSchema,
  ConfidenceSchema,
  EndpointSchema,
  ErrorCodeSchema,
  OutcomeSchema,
  ProfileSchema,
  QuotaStateSchema,
  RefusalReasonSchema,
  RetrievalModeSchema,
  RetrievedEntrySchema,
  ServedBySchema,
  UsageSchema,
} from "./domain.ts";
import { IntentSchema, SupportLabelSchema } from "./intents.ts";

// SSE contract (docs/03 §4). Wire format: `event: <name>\ndata: <json>\n\n`.
// The gateway validates before sending; the console and eval runner validate on receipt.

export const MetaEventSchema = z.object({
  request_id: z.string(),
  tenant: z.string(),
  endpoint: EndpointSchema,
  profile: ProfileSchema,
});

export const RetrievalEventSchema = z.object({
  mode: RetrievalModeSchema,
  entries: z.array(RetrievedEntrySchema),
  knn_intent: IntentSchema,
  vote_share: z.number().min(0).max(1),
  top1_similarity: z.number(),
});

export const RouteEventSchema = z.object({
  attempt: z.number().int().positive(),
  backend_id: z.string(),
  model: z.string(),
  // 'primary' | 'fallback:<prev_status>' | 'escalation:<why>'
  reason: z.string(),
});

export const AttemptFailedEventSchema = z.object({
  attempt: z.number().int().positive(),
  backend_id: z.string(),
  status: AttemptStatusSchema,
  error: z.string(),
  latency_ms: z.number().int().nonnegative(),
});

export const IntentEventSchema = z.object({
  llm_intent: SupportLabelSchema,
  final_intent: SupportLabelSchema,
  confidence: ConfidenceSchema,
});

export const TokenEventSchema = z.object({ text: z.string() });

export const ToolCallEventSchema = z.object({
  name: z.string(),
  arguments: z.unknown(),
});

export const RefusalEventSchema = z.object({
  reason: RefusalReasonSchema,
  message: z.string(),
});

export const ErrorEventSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
});

export const DoneEventSchema = z.object({
  outcome: OutcomeSchema,
  served_by: ServedBySchema.nullable(),
  fallback_fired: z.boolean(),
  escalated: z.boolean(),
  usage: UsageSchema,
  latency_ms: z.number().int().nonnegative(),
  ttft_ms: z.number().int().nonnegative().nullable(),
  cost_usd: z.number().nonnegative(),
  quota: QuotaStateSchema,
  // Routing exclusions from router/plan.ts (docs/04 §4), e.g. "excluded gemini-3.5-flash: tenant policy".
  decisions: z.array(z.string()),
});

export const SSE_EVENT_SCHEMAS = {
  meta: MetaEventSchema,
  retrieval: RetrievalEventSchema,
  route: RouteEventSchema,
  attempt_failed: AttemptFailedEventSchema,
  intent: IntentEventSchema,
  token: TokenEventSchema,
  tool_call: ToolCallEventSchema,
  refusal: RefusalEventSchema,
  error: ErrorEventSchema,
  done: DoneEventSchema,
} as const;

export type SseEventName = keyof typeof SSE_EVENT_SCHEMAS;
export type SseEventData<N extends SseEventName> = z.infer<(typeof SSE_EVENT_SCHEMAS)[N]>;
export type SseEvent = { [N in SseEventName]: { event: N; data: SseEventData<N> } }[SseEventName];

export const SSE_EVENT_NAMES = Object.keys(SSE_EVENT_SCHEMAS) as SseEventName[];

export function isSseEventName(name: string): name is SseEventName {
  return Object.hasOwn(SSE_EVENT_SCHEMAS, name);
}

export type ParsedSseEvent =
  | { ok: true; event: SseEvent }
  | { ok: false; reason: "unknown_event"; name: string }
  | { ok: false; reason: "invalid_data"; name: SseEventName; issues: z.core.$ZodIssue[] };

// Validates one received event. `data` is the already JSON-parsed payload.
// Unknown event names are reported, not thrown, so clients can ignore them (docs/06 §2).
export function parseSseEvent(name: string, data: unknown): ParsedSseEvent {
  if (!isSseEventName(name)) return { ok: false, reason: "unknown_event", name };
  const result = SSE_EVENT_SCHEMAS[name].safeParse(data);
  if (!result.success) return { ok: false, reason: "invalid_data", name, issues: result.error.issues };
  return { ok: true, event: { event: name, data: result.data } as SseEvent };
}

export type DoneEvent = z.infer<typeof DoneEventSchema>;
export type IntentEventData = z.infer<typeof IntentEventSchema>;

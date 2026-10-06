import type { AttemptStatus, BackendId, ToolDecl } from "@mir/shared";
import type { Price } from "../config/pricing.ts";

// Backend contract (docs/04 §1). Adapters translate provider responses into StreamChunks and provider
// failures into BackendError statuses; the router (router/execute.ts) owns timeouts and fallback.

export type BackendKind = "gemini" | "ollama" | "mock";
export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface BackendSpec {
  id: BackendId; // stable id used in tenant policy and metering
  kind: BackendKind;
  model: string; // provider model id
  priority: number; // lower = tried first
  supportsTools: boolean; // owner rule: Gemini only if version >= 3; Ollama from OLLAMA_SUPPORTS_TOOLS
  ttftTimeoutMs: number;
  totalTimeoutMs: number;
  price: Price;
}

export type ChatTurn = { role: "user" | "assistant"; content: string };

export interface GenerateRequest {
  system?: string;
  messages: ChatTurn[];
  maxOutputTokens: number;
  tools?: ToolDecl[];
  overrides?: { thinkingLevel?: ThinkingLevel }; // used by escalation (docs/04 §6)
  // Per-request mock behaviour (debug overrides are per request: serverless instances share no memory).
  mock?: { latencyMs?: number; fail?: boolean; reply?: string };
  signal: AbortSignal; // aborts upstream on timeout or client disconnect
}

export type UsageChunk = {
  type: "usage";
  promptTokens: number;
  completionTokens: number;
  thinkingTokens: number;
  estimated: boolean;
};

export type StreamChunk =
  { type: "text"; text: string } | { type: "tool_call"; name: string; arguments: unknown } | UsageChunk;

export interface Backend {
  spec: BackendSpec;
  stream(req: GenerateRequest): AsyncIterable<StreamChunk>; // throws BackendError
}

export class BackendError extends Error {
  override name = "BackendError";
  readonly status: AttemptStatus;
  readonly retryable: boolean;

  constructor(status: AttemptStatus, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.status = status;
    this.retryable = options.retryable ?? true;
  }
}

// Rough estimate (≈ 4 chars per token) for backends that do not report usage (mock).
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

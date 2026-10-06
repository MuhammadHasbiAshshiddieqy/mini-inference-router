import { ErrorResponseSchema, createSseParser, parseSseEvent, type SseEvent } from "@mir/shared";
import type { z } from "zod";
import { GATEWAY_URL } from "./config.ts";

// Gateway client. Streaming uses fetch() + ReadableStream, not EventSource: EventSource cannot send the
// Authorization header (docs/06 §2). Every SSE event is validated with the shared Zod schemas.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, requestId: string | null, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  const requestId = res.headers.get("x-request-id");
  const body: unknown = await res.json().catch(() => undefined);
  const parsed = ErrorResponseSchema.safeParse(body);
  if (parsed.success) {
    const e = parsed.data.error;
    return new ApiError(res.status, e.code, e.message, e.request_id, e.details);
  }
  return new ApiError(res.status, `http_${res.status}`, res.statusText || "Request failed", requestId);
}

export async function getJson<T>(path: string, schema: z.ZodType<T>, key?: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw await toApiError(res);
  return schema.parse(await res.json());
}

export type StreamOptions = {
  path: "/v1/chat" | "/v1/support/answer";
  key: string;
  body: unknown;
  signal: AbortSignal;
  onOpen?: (requestId: string | null) => void;
  onEvent: (event: SseEvent) => void;
  onInvalid?: (name: string, detail: unknown) => void;
};

export async function streamEvents(opts: StreamOptions): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}${opts.path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${opts.key}`, "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw await toApiError(res);
  opts.onOpen?.(res.headers.get("x-request-id"));

  const parser = createSseParser((raw) => {
    let data: unknown;
    try {
      data = JSON.parse(raw.data);
    } catch {
      opts.onInvalid?.(raw.event, raw.data);
      return;
    }
    const parsed = parseSseEvent(raw.event, data);
    if (parsed.ok) opts.onEvent(parsed.event);
    else opts.onInvalid?.(raw.event, parsed); // unknown events are ignored, as the contract allows
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.end();
}

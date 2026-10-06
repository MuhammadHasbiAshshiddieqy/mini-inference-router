import { SSE_EVENT_SCHEMAS, type SseEventData, type SseEventName } from "@mir/shared";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "./types.ts";

// Server-Sent Events on top of Hono's streamSSE (docs/03 §4, docs/12 §1):
// - every event is validated against the shared Zod schema before it is written (contract drift = bug);
// - a `: ping` comment every 10 s keeps proxies from closing an idle stream;
// - anti-buffering headers, so tokens are flushed as they arrive (never gzip SSE routes);
// - `signal` aborts when the client disconnects, so the router can stop the upstream generation.
// Hono's own onError would write a raw `error` event outside our contract, so all errors are handled inside `run`.

export type SendEvent = <N extends SseEventName>(event: N, data: SseEventData<N>) => Promise<void>;

export type EventStreamContext = { send: SendEvent; signal: AbortSignal };

export const HEARTBEAT_MS = 10_000;

export function openEventStream(
  c: Context<AppEnv>,
  run: (ctx: EventStreamContext) => Promise<void>,
  options: { heartbeatMs?: number } = {},
): Response {
  const clientAbort = new AbortController();
  const abort = () => clientAbort.abort("client_aborted");
  c.req.raw.signal.addEventListener("abort", abort, { once: true });

  const response = streamSSE(c, async (stream) => {
    stream.onAbort(abort); // the response body was cancelled by the client
    let closed = false;
    const heartbeat = setInterval(() => {
      if (!closed && !clientAbort.signal.aborted) void stream.write(": ping\n\n").catch(abort);
    }, options.heartbeatMs ?? HEARTBEAT_MS);

    const send: SendEvent = async (event, data) => {
      const payload = SSE_EVENT_SCHEMAS[event].parse(data); // throws on contract violations
      if (clientAbort.signal.aborted) return; // nobody is listening any more
      await stream.writeSSE({ event, data: JSON.stringify(payload) });
    };

    try {
      await run({ send, signal: clientAbort.signal });
    } finally {
      closed = true;
      clearInterval(heartbeat);
      c.req.raw.signal.removeEventListener("abort", abort);
    }
  });

  // Set on both the context and the response: Hono copies context headers onto the final response when a
  // middleware (e.g. CORS) touched c.res first, which would otherwise restore streamSSE's plain "no-cache".
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  };
  for (const [name, value] of Object.entries(headers)) {
    c.header(name, value);
    response.headers.set(name, value);
  }
  return response;
}

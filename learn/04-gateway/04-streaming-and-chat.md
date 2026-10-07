# Gateway 04 · Streaming and `/v1/chat` (≈ 20 min)

Files: `http/sse.ts`, `routes/chat.ts`, and in the shared package `sse.ts` and `sse-parser.ts`.

## What streaming looks like on the wire

The answer is sent with **Server-Sent Events (SSE)**: one long HTTP response with
`Content-Type: text/event-stream`, made of small text blocks separated by a blank line.

```
event: meta
data: {"request_id":"01a1…","tenant":"acme","endpoint":"chat","profile":"local"}

event: route
data: {"attempt":1,"backend_id":"ollama","model":"gemma4:e2b-mlx","reason":"primary"}

event: token
data: {"text":"Check"}

event: token
data: {"text":" your"}

: ping

event: done
data: {"outcome":"ok","served_by":{"backend_id":"ollama",…},"usage":{…},"latency_ms":592,"ttft_ms":350,"cost_usd":0,…}
```

Lines starting with `:` are comments; the server sends `: ping` every 10 s so proxies do not close an idle
connection. The ten event types and their fields are defined once, with Zod, in
[`packages/shared/src/sse.ts`](../../packages/shared/src/sse.ts):
`meta, retrieval, route, attempt_failed, intent, token, tool_call, refusal, error, done`. `done` is always last.

Why not WebSockets? The data only flows one way (server → client), SSE works through ordinary HTTP proxies and
on Vercel, and `curl -N` can show it. Why not the browser's built-in `EventSource`? It cannot send an
`Authorization` header, so the console reads the stream with `fetch()` instead (chapter [06](../06-console.md)).

## `http/sse.ts`: one helper for both endpoints

[`openEventStream(c, run)`](../../apps/gateway/src/http/sse.ts) wraps Hono's `streamSSE` and gives `run` two things:

- `send(event, data)` — validates `data` against the shared schema for that event, then writes it. A wrong field
  name fails loudly here instead of silently breaking the console.
- `signal` — an `AbortSignal` that fires when the client disconnects, so the router can stop the model.

It also sets the headers that stop proxies from buffering the stream (`Cache-Control: no-cache, no-transform`,
`X-Accel-Buffering: no`) and runs the heartbeat. A test caught that a middleware could silently undo one of those
headers; the comment above the header loop explains the fix.

Important consequence: **once the stream is open, the HTTP status is already 200.** Errors before that point
(auth, validation, quota, routing plan) are normal JSON errors with their status code. Errors after that point
are an `error` event followed by `done`.

## `routes/chat.ts`

Read [`routes/chat.ts`](../../apps/gateway/src/routes/chat.ts) from the bottom (`chatRoutes`) up:

1. `admit(…)` with the chat schema and a `precheck` that builds the routing **plan** (and rejects a conversation
   with only system messages).
2. If the body says `"stream": false`, run and return **one JSON object** (`answer`, `tool_calls`, `attempts`,
   `decisions`, usage, cost, quota…).
3. Otherwise `openEventStream(…)`: send `meta`, run, then send `error` (if any) and `done`.

Both modes call the same core, `runChat(c, deps, admission, plan, sink, signal)`. The difference is the
**sink** — the object that decides what to do with each piece:

```ts
type Sink = {
  streaming: boolean;                    // SSE: commit on the first token; JSON: never commit
  send: SendEvent;                       // SSE: write an event; JSON: do nothing
  onText: (text: string) => Promise<void>;
  onToolCall: (name: string, args: unknown) => Promise<void>;
  onNewAttempt: () => void;              // JSON: throw away text from a failed attempt
};
```

`runChat` calls `execute()` with hooks that forward to the sink, records every attempt, sums tokens and cost,
maps the router's result to an outcome (`ok`, `ok_after_fallback`, `partial_error`, `all_backends_failed`,
`client_aborted`), then calls `settle()` and builds the `done` payload.

A neat consequence of the sink design: in JSON mode the user sees nothing until the end, so a model that fails
halfway can still be replaced by the next backend. In SSE mode the same failure becomes `partial_error`.

## Messages, roles and tools

`/v1/chat` accepts OpenAI-style messages (`system`, `user`, `assistant`). `system` messages are joined into the
backend's system instruction; the rest become the conversation. `tools` are passed through to backends that
support them and come back as `tool_call` events. The gateway **never executes** tools: that is the product
team's job (a documented cut).

## Try it

```bash
curl -N localhost:8787/v1/chat -H "authorization: Bearer $SEED_KEY_ACME" -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hello in five words."}]}'
```

Then stop curl with Ctrl-C halfway through a long answer and look at the request in the database: its outcome is
`client_aborted`, and its tokens are an estimate.

Next: [05 · The support assistant](05-support-assistant.md).

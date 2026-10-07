# Gateway 03 · Backends and the router (≈ 35 min)

Files: `backends/types.ts`, `backends/mock.ts`, `backends/gemini.ts`, `backends/ollama.ts`,
`backends/registry.ts`, `backends/ollama-health.ts`, `config/profiles.ts`, `router/plan.ts`, `router/execute.ts`.

The router decides **which** model answers and **what to do when one fails**. The brief asks for rules "you can
defend" and fallback that is "recorded and inspectable"; this is where both live.

## The contract every backend implements

[`backends/types.ts`](../../apps/gateway/src/backends/types.ts) (65 lines). Read it first.

```ts
interface Backend {
  spec: BackendSpec;                                      // id, model, priority, timeouts, price, supportsTools
  stream(req: GenerateRequest): AsyncIterable<StreamChunk>;   // yields text / tool_call / usage chunks
}
```

- `GenerateRequest` = system prompt, messages, max output tokens, optional tools, an optional thinking level (for
  escalation), optional mock settings, and an **`AbortSignal`** (so the router can cancel it).
- `StreamChunk` = `{type:"text"}` | `{type:"tool_call"}` | `{type:"usage"}` (token counts, usually at the end).
- A backend that fails throws **`BackendError(status, message)`** where `status` is one of `rate_limited`,
  `upstream_error`, `network_error`, `aborted`… The router never sees a provider-specific error.

That is the whole point of the contract: the router does not know or care whether it is talking to Google, a
local model or a fake.

## The three adapters

Read them in this order (easiest first):

**[`mock.ts`](../../apps/gateway/src/backends/mock.ts)** — waits `latencyMs`, maybe fails (`failRate` or
`debug.mock_fail`), then yields its reply word by word and estimates usage (`characters / 4`, flagged
`estimated: true`). For the support assistant the caller passes `mock.reply` = a valid intent header plus the
best knowledge-base answer, so even the fake gives a grounded answer. Its price is 0.

**[`ollama.ts`](../../apps/gateway/src/backends/ollama.ts)** — calls the local Ollama server with the official
`ollama` package: `chat({ model, messages, stream: true, think: false, options: { num_predict } })`. It forwards
`message.content` as text, ignores any `thinking` text, and takes token counts from the final chunk. A new client
is created for every attempt so that aborting one attempt cannot cancel another.

**[`gemini.ts`](../../apps/gateway/src/backends/gemini.ts)** — calls Google with `@google/genai`
(`generateContentStream`). Details that matter: the thinking level is *always* set (otherwise the model thinks a
lot and gets slow); temperature is never set (Google's advice for Gemini 3); "thought" parts are never forwarded
but their tokens (`thoughtsTokenCount`) are counted and billed; tools are passed as JSON Schema.

Both real adapters end with a `classify…Error` function that maps HTTP 429 → `rate_limited`, 5xx and 400 →
`upstream_error`, connection failures → `network_error`, and an empty answer → `upstream_error`.

[`registry.ts`](../../apps/gateway/src/backends/registry.ts) creates the backends of the active profile;
[`ollama-health.ts`](../../apps/gateway/src/backends/ollama-health.ts) checks Ollama cheaply for `/healthz` and
warms it up at boot.

## Profiles and priority

[`config/profiles.ts`](../../apps/gateway/src/config/profiles.ts) turns env into a list of `BackendSpec`s,
in priority order. Two details:

- Each backend has a stable **id** (`gemini-3.5-flash`) separate from its **model** (`gemini-3.5-flash`,
  `gemini-3-flash-preview`, …). Tenant permissions and metering use the id, so changing a model version does
  not break them.
- `geminiSupportsTools(model)` reads the version from the model name: tools only on Gemini ≥ 3 (an owner rule,
  because 2.5 Flash tool calling was unreliable).

## The plan: a pure function

[`router/plan.ts`](../../apps/gateway/src/router/plan.ts) (47 lines). Given the profile's backends, the tenant's
allowed backends and whether the request has tools, it returns the candidates in order **and a list of
decisions** explaining every exclusion:

1. **Tenant policy** — keep only `allowed_backends`. None left → **403 `no_allowed_backend`**.
2. **Capability** — with tools, keep only `supportsTools`. None left → **422 `tools_unsupported`**.
3. **Priority** — sort.

The decisions travel to the client in the final `done` event (`"excluded gemini-3.5-flash: not in tenant
allowed_backends"`). The plan runs during admission, *before* any tokens are reserved.

## Execution with fallback: `router/execute.ts`

This is the longest and most important file of the router (≈ 330 lines). Read the header comment, then the
`execute` function. In pseudocode:

```
for each candidate:
    emit "route" (attempt n, backend, reason: "primary" or "fallback:<previous status>")
    if debug.force_fail includes it → record "forced_failure", continue
    start two timers: TTFT (no content yet after N s) and total; link to the client's disconnect
    read the backend's stream chunk by chunk:
        usage chunk → remember it
        content chunk → stop the TTFT timer; hand it to the consumer (hooks.onChunk)
    stream finished → record "ok", return
    on error:
        client disconnected          → record "aborted", stop          (outcome client_aborted)
        consumer said "stop"         → record it, stop                 (quality decision, see chapter 05)
        content already reached user → record "mid_stream_error", stop (outcome partial_error) ← no retry!
        otherwise                    → record the failure, try the next candidate
all failed → outcome all_backends_failed
```

Five ideas to take away:

1. **The commit point.** Fallback is allowed only until the first piece of the answer has been *shown to the
   user*. After that, retrying with another model would contradict text they already read, so the failure is
   reported instead. The *consumer* decides when that moment is (`ctx.commit()`): the chat route commits on the
   first token; the support assistant only after the intent header is accepted. In JSON mode nothing is shown
   until the end, so it never commits.
2. **Timeouts that cannot be ignored.** Each `next()` on the stream is raced against the attempt's abort signal
   (`nextOrAbort`). Even if a provider library ignores the signal, the router moves on when the timer fires.
3. **Every attempt is recorded**, through `hooks.onAttemptDone`, with its reason, status, tokens, cost, latency
   and TTFT. That is the "inspectable" part of the brief: open any request in the console's request inspector.
4. **Hooks keep the router generic.** The router does not know about SSE or the database. Routes pass callbacks:
   `onRoute`, `onAttemptFailed`, `onAttemptDone`, `onChunk`, `onEnd`.
5. **Honest token counts.** If an attempt ends without the provider's usage after text was streamed (e.g. the
   client disconnected and Ollama never sent its final chunk), the usage is *estimated* and flagged rather than
   recorded as zero. `totals()` sums usage and cost across all attempts.

**Fallback vs escalation.** Fallback reacts to a *failing backend* (error, timeout, rate limit) and tries the
next one. Escalation reacts to a *bad answer* (unparseable header, intent disagreement) and retries once on the
same backend with more thinking. Escalation lives in the support assistant (chapter 05) and calls `execute()` a
second time with `firstReason: "escalation:…"`.

## How it is tested

[`router/execute.test.ts`](../../apps/gateway/src/router/execute.test.ts) uses **fake backends** (scripted
lists of "wait / text / fail" steps) and **fake timers** (Vitest moves the clock instantly), so a 30-second
timeout test takes milliseconds. Every scenario from the spec has a test: 429 → fallback, TTFT timeout, total
timeout, network error, forced failure, failure after the first token, all failing, client disconnect.
The adapters are tested against **recorded real responses** in `backends/fixtures/`.

## Try it

```bash
curl -s localhost:8787/v1/chat -H "authorization: Bearer $SEED_KEY_ACME" -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}],"stream":false,"debug":{"force_fail":["ollama"]}}' \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).attempts))"
# [{attempt:1, backend_id:'ollama', reason:'primary', status:'forced_failure'}, {attempt:2, backend_id:'mock', reason:'fallback:forced_failure', status:'ok'}]
```

Next: [04 · Streaming and `/v1/chat`](04-streaming-and-chat.md).

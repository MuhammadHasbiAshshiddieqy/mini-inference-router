# 04 — Routing and Backends

## 1. Backend interface (`apps/gateway/src/backends/types.ts`)

```ts
export type BackendKind = "gemini" | "ollama" | "mock";

export interface BackendSpec {
  id: string;                    // stable id used in policy & metering, e.g. "gemini-3.5-flash"
  kind: BackendKind;
  model: string;                 // provider model id
  priority: number;              // lower = tried first
  supportsTools: boolean;        // owner rule: Gemini only if version >= 3
  ttftTimeoutMs: number;
  totalTimeoutMs: number;
  price: { inputPer1M: number; outputPer1M: number; source: string };  // USD; thinking tokens billed as output
  options?: Record<string, unknown>; // e.g. { thinkingLevel: "minimal" }, { keepAlive: "30m" }
}

export interface GenerateRequest {
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxOutputTokens: number;
  tools?: ToolDecl[];
  overrides?: { thinkingLevel?: "minimal" | "low" | "medium" | "high" };  // used by escalation
  signal: AbortSignal;           // aborts upstream on timeout / client disconnect
}

export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; arguments: unknown }
  | { type: "usage"; promptTokens: number; completionTokens: number; thinkingTokens: number; estimated: boolean };

export interface Backend {
  spec: BackendSpec;
  stream(req: GenerateRequest): AsyncIterable<StreamChunk>;   // throws BackendError
}

export class BackendError extends Error {
  constructor(public status: AttemptStatus, message: string, public retryable = true, public cause?: unknown) { super(message); }
}
```

Adapters translate provider errors into `BackendError` statuses: HTTP 429 → `rate_limited`, 5xx → `upstream_error`,
fetch/DNS/ECONNREFUSED → `network_error`, provider 400 → `upstream_error` (retryable = true; the request was already
validated by us, so a provider 400 is that provider's problem). An empty stream counts as `upstream_error`.

## 2. Adapters

### Gemini (`backends/gemini.ts`), official `@google/genai`

- `ai.models.generateContentStream({ model, contents, config: { systemInstruction, maxOutputTokens, thinkingConfig: { thinkingLevel }, abortSignal, tools } })`
- **Verify against current docs before coding**: field names (`thinkingConfig.thinkingLevel`, `abortSignal`), and model IDs
  via `ai.models.list()`. Google docs (checked 2026-10-06) list `gemini-3.5-flash` (GA) and `gemini-3-flash-preview`.
- **Do not set `temperature`/`topP`/`topK`** on Gemini 3 (Google recommends the default of 1.0; lower values may cause looping).
- If `thinkingLevel` is not specified, `gemini-3.5-flash` defaults to `medium` and `gemini-3-flash-preview` to `high`, so **always set it explicitly** (default `minimal` from env). Both models support `minimal | low | medium | high`. In `@google/genai` use the `ThinkingLevel` enum (`ThinkingLevel.MINIMAL`, …) in `config.thinkingConfig.thinkingLevel` (source: https://ai.google.dev/gemini-api/docs/interactions/whats-new-gemini-3.5 and https://googleapis.github.io/js-genai/release_docs/enums/types.ThinkingLevel.html, checked 2026-10-06).
- `config.abortSignal` cancels **client-side only**: Google still bills usage already generated. So an aborted attempt records the tokens it reported (if any) and is still charged to quota (SDK `GenerateContentConfig` docs, checked 2026-10-06).
- Function calling on `gemini-3.5-flash` is strict: every `FunctionResponse` must carry the `id` and `name` of its `FunctionCall`. We only pass tools through, so this matters only to clients that continue a tool conversation.
  `minimal` does not guarantee zero thinking, so record `thoughtsTokenCount` anyway.
- Usage: take `usageMetadata` from the last chunk: `promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `totalTokenCount`.
- Function calling on Gemini 3: return `thoughtSignature` with tool results in follow-up turns. We only pass tools through and
  emit `tool_call` events; we do not execute tools (documented cut). This adapter is the only one with `supportsTools: true` in the cloud profile.

### Ollama (`backends/ollama.ts`), official `ollama` npm package

- `new Ollama({ host: OLLAMA_URL }).chat({ model, messages, stream: true, think: OLLAMA_THINK, options: { num_predict }, keep_alive: "30m", tools? })`
- Default models: **`gemma4:e2b-mlx`** natively on the Mac (MLX engine, Apple Silicon only), **`gemma4:e2b-it-qat`** in the Docker container (GGUF on CPU; MLX cannot run in a Linux container). Both come from env. See doc 12 §4.
- If the stream contains a separate `thinking` field, never forward it; count it as thinking tokens if reported. Use Gemma's recommended sampling defaults (do not lower temperature).
- Usage from the final chunk: `prompt_eval_count`, `eval_count`. Thinking tokens = 0 unless the model reports them.
- Abort: `ollama.abort()` aborts **all** streams of that client instance (README, checked 2026-10-06), so create one `Ollama` client per attempt and call its `abort()` when the attempt's AbortSignal fires. Re-check the per-stream iterator API against the installed package types in Phase 4.
- Verified locally 2026-10-06 (Ollama 0.32.5): `think: false` on `gemma4:e2b-mlx` returns no `thinking` field; `nomic-embed-text` returns 768-dim vectors. `gemma4:e2b` and `gemma4:e2b-mlx` have the same model id on the Mac.
- `supportsTools` comes from env (`OLLAMA_SUPPORTS_TOOLS`), because it depends on the pulled model (Gemma 4 supports native function calling).
- Startup check (`/healthz` and boot): `GET /api/tags`. If the chat or embed model is missing, log a clear instruction
  (`ollama pull <model>` or `docker compose --profile ollama up ollama-pull`). Do not crash: the router will fall back to mock and record `network_error`/`upstream_error`.
- Warm-up: on boot, fire one tiny generation in the background so the first user request does not pay the model load time.

### Mock (`backends/mock.ts`)

- Configurable `latencyMs` (to first token), per-token delay (≈15 ms), `failRate` (0..1), and per-request `debug` overrides.
- Chat: emits a fixed sentence ("[mock] This is a mock response…") word by word.
- Support: emits a **valid** header `INTENT: <knn_intent>\n---\n` followed by the top-1 retrieved KB response. This makes it
  a realistic degraded backend (the answer is still grounded) and makes fallback visibly useful in the demo.
- Tokens are estimated as `ceil(chars/4)` with `estimated: true`. Price 0. The UI labels it "mock".

## 3. Profiles (`config/profiles.ts`)

| Profile | Backends (priority order) | Embedding |
|---|---|---|
| `cloud` (deployed) | `gemini-3.5-flash` → `gemini-3-flash` → `mock` | Gemini embedding |
| `local` (Docker or native) | `ollama` → `mock` | nomic-embed-text |
| `hybrid` (optional, eval/dev) | `gemini-3.5-flash` → `ollama` → `mock` | Gemini embedding |

Backend ids: `gemini-3.5-flash`, `gemini-3-flash`, `ollama`, `mock`. Tenant `allowed_backends` refer to these ids.
Backend id ≠ model id: `gemini-3.5-flash` → model `GEMINI_PRIMARY_MODEL` (default `gemini-3.5-flash`), `gemini-3-flash` → model
`GEMINI_FALLBACK_MODEL` (default `gemini-3-flash-preview`), `ollama` → `OLLAMA_CHAT_MODEL`. Ids stay stable when model versions change.

## 4. Routing rules (`router/plan.ts`, a pure function)

```
plan(profileBackends, tenant, request) -> { candidates: BackendSpec[], decisions: string[] }
```

Applied in order. Every exclusion is recorded in `decisions` (returned in the `done` payload and logged):

1. **Tenant policy**: keep only `tenant.allowed_backends`. Empty → 403 `no_allowed_backend`.
2. **Capability**: if `request.tools` is present, keep only `supportsTools`. Empty → 422 `tools_unsupported`.
   (Owner rule: tool calling only on Gemini ≥ 3; 2.x is excluded by policy because its tool calling proved unreliable.)
3. **Priority**: sort by `priority` (cheapest adequate real model first, then the independent-quota fallback, then the mock safety net).
4. **Circuit breaker** (P2, optional): skip a backend for 30 s after 3 consecutive failures. In-memory per instance (on Vercel this
   only helps warm instances, so say so in the report). Recorded as `skipped_circuit_open`.

### Why this order (defend in the report with eval numbers)

- **Primary `gemini-3.5-flash`**: best quality per cost on the eval, GA (stable), supports tools reliably; `thinking: minimal` keeps TTFT low.
- **Fallback `gemini-3-flash`**: different model, so a **separate free-tier quota**. A 429 or model-specific outage on the primary usually does not affect it.
- **Mock last**: guarantees a grounded degraded answer (top-1 KB response) when the provider as a whole is down. It does not protect quality, only availability, and it is labelled as mock.
- Known trade-off: both real backends share one provider (Google), so their failures are correlated for account, network or provider-wide outages. Accepted for zero cost; mitigated by mock; documented.

## 5. Execution with fallback (`router/execute.ts`)

```
for each candidate (attempt = 1..n):
  emit route{attempt, backend_id, model, reason}
  start attempt timer; controller = new AbortController() linked to client-abort signal
  arm TTFT timer (spec.ttftTimeoutMs) and total timer (spec.totalTimeoutMs)
  try:
    for await chunk of backend.stream(req with controller.signal):
      if first content chunk:
        clear TTFT timer; mark COMMITTED (no more fallback after this point)
      forward chunk to the consumer (assistant parser or SSE writer)
    record attempt ok → return
  catch err:
    status = classify(err)  // timeout_ttft | timeout_total | rate_limited | upstream_error | network_error | forced_failure | aborted
    record attempt failed (tokens if known), emit attempt_failed
    if client aborted → stop, outcome client_aborted
    if COMMITTED → emit error event, outcome partial_error, stop (no silent retry)
    else continue to next candidate with reason = `fallback:${status}`
all failed → 502 all_backends_failed (or error+done if the stream is open)
```

Notes:
- "COMMITTED" means content has been **forwarded to the client**. For the support endpoint, the header phase (before `---`) is not yet forwarded, so a failure during the header can still fall back.
- `debug.force_fail` makes `backend.stream` throw `forced_failure` immediately. This is the deterministic way to demo fallback on the deployed URL.
- Timers must always be cleared (use `try/finally`) to avoid leaks.

## 6. Escalation (support assistant only), different from fallback

| | Fallback | Escalation |
|---|---|---|
| Trigger | backend **failure** (error, timeout, rate limit) | **quality** signal: invalid output header, or LLM intent disagrees with retrieval |
| Action | next backend in priority order | retry once on the **same primary** with `thinkingLevel: "low"` and a format reminder |
| Max | all candidates | 1 per request |
| Recorded | `reason: fallback:<status>` | `reason: escalation:<why>`, `requests.escalated = true` |

If the escalated attempt fails as a backend error, normal fallback continues from there.
For non-Gemini backends (Ollama), escalation re-sends the same request with the format reminder only.

## 7. Pricing (`config/pricing.ts`)

Prices in USD per 1M tokens. Each entry carries `source` + `checked` date. **Verify against the official Gemini pricing page before final eval.**

| backend | input | output (incl. thinking) | note |
|---|---|---|---|
| gemini-3.5-flash | 1.50 | 9.00 | official pricing page, standard paid tier (https://ai.google.dev/gemini-api/docs/pricing, checked 2026-10-06) |
| gemini-3-flash (`gemini-3-flash-preview`) | 0.50 (text/image/video; audio 1.00) | 3.00 | same source and date |
| embedding model | not metered | — | embedding cost is not charged to tenant quota (doc 03 §5); price not listed on the pricing page fetched 2026-10-06 |
| ollama | `LOCAL_COST_PER_1M` (default 0) | `LOCAL_COST_PER_1M` (default 0) | optional flat rate to model hardware/electricity cost; when 0, UI shows "$0 (local)" |
| mock | 0 | 0 | |

Cost formula per attempt: `(prompt * in + (completion + thinking) * out) / 1e6`. Request cost = sum over attempts.
We run on the free tier, so this is the **list-price equivalent cost**. State that clearly in the UI ("est.") and in the report.

## 8. Tests required (Vitest, no network)

- `plan.test.ts`: tenant policy filter, tools filter (Gemini 3 and Ollama-with-tools only), ordering, empty → correct errors.
- `execute.test.ts` with fake backends: success on first try; 429 → fallback; TTFT timeout → fallback (use fake timers);
  total timeout; network error; forced failure; failure **after** first token → `partial_error`, no fallback; all fail → `all_backends_failed`;
  client abort → `client_aborted` and upstream signal aborted; attempt rows recorded with correct reasons and statuses.
- `pricing.test.ts`: cost math including thinking tokens.
- Adapter contract tests with recorded fixtures (no live calls in CI). Add one **opt-in** live smoke test per adapter behind `LIVE=1`.

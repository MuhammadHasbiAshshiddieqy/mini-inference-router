# 06 — Console (Vue 3)

`apps/console`: Vue 3 + Vite + TypeScript + Vue Router + Tailwind CSS. State lives in composables (no Pinia unless needed).
It is a **client of the gateway** and holds no secrets beyond what the operator types in.

## 1. Pages

### `/playground` (R15, R16)

Layout: left = conversation and input. Right = **inspector panel**.

Controls (top bar):
- **Tenant key**: a dropdown of demo tenants (from `VITE_DEMO_TENANTS`, a JSON array of `{name,key}`) plus a "custom key" input (for the private `reviewer` key; kept in `sessionStorage` only). Debug controls appear when the tenant allows debug (from `GET /v1/usage`).
- **Mode**: `Support assistant` (`/v1/support/answer`) | `Raw chat` (`/v1/chat`).
- **Debug** (shown only for tenants with `allow_debug`: `acme`, `reviewer`, `eval`): checkboxes "force-fail gemini-3.5-flash", "force-fail gemini-3-flash", "mock fails", "embedding outage" (→ lexical fallback); mock latency slider.
- **Example prompts** chips: 1 easy in-domain, 1 typo-heavy, 1 confusable (refund tracking vs policy), 1 OOS, 1 prompt injection.

Answer area:
- Tokens append live as they stream. A blinking caret shows while streaming.
- `{{Placeholder}}` rendered as a small grey chip.
- Refusal rendered as a distinct amber card with the reason code.
- Mid-stream `error` rendered inline in red (and the answer is marked partial).

Inspector panel (updates as events arrive):

| Section | Content |
|---|---|
| Served by | backend id + model, badge **FALLBACK** if `fallback_fired`, **ESCALATED** if `escalated`, **MOCK** if mock |
| Attempts timeline | one row per `route`/`attempt_failed`: `#1 gemini-3.5-flash → forced_failure (2 ms)`, `#2 gemini-3-flash → ok` |
| Intent | final intent, LLM intent vs kNN intent (highlight if they differ), confidence level pill + score, signals table |
| Retrieved | mode badge (`dense` / `hybrid` / **LEXICAL FALLBACK**); top-k cards: intent, dense similarity bar, trigram similarity, RRF score + dense/lex rank (hybrid), instruction, response preview (expandable) |
| Metrics | TTFT, total latency, prompt/completion/thinking tokens (with "est." if estimated), cost in USD (6 decimals, "est."), quota remaining |
| Raw | collapsible list of the raw SSE events (useful in the video) |
| Link | "Open request" → `/requests/:id` |

### `/usage` (R17)

- Needs the admin key (input field, kept in `sessionStorage`; never in the build).
- Table per tenant: requests, ok / refused / fallback / errors, total tokens, total cost (est.), quota limit, used, **remaining** (progress bar), last request time.
- Refresh button plus auto-refresh every 10 s.
- Optional (P2): a small bar of requests per backend.

### `/requests` and `/requests/:id`

- List (admin key): time, tenant, endpoint, outcome, served model, fallback, tokens, latency, cost.
- Detail: the full `requests` row + `route_attempts` table (attempt_no, backend, reason, status, error_detail, tokens, latency, ttft, cost).
  This is the "decision recorded and inspectable" evidence (R9).

## 2. Streaming client (`src/lib/sse.ts`)

- **Do not use `EventSource`**: it cannot send the `Authorization` header. Use `fetch()` with `Accept: text/event-stream`, then `response.body.getReader()` + `TextDecoder`, and parse `event:`/`data:` blocks (small own parser, or `eventsource-parser`).
- Validate each event with the shared Zod schemas from `packages/shared`. Unknown events are ignored and logged to the console.
- Non-2xx before the stream opens: show `error.code` + `message` (e.g. `quota_exceeded` with remaining = 0).
- Support cancel (AbortController), wired to a "Stop" button.

## 3. Config

```
VITE_GATEWAY_URL=http://localhost:8787
VITE_DEMO_TENANTS=[{"name":"acme (pro, debug)","key":"..."},{"name":"globex (restricted)","key":"..."},{"name":"tiny (low quota)","key":"..."}]
```

Exposing demo tenant keys in a public SPA is acceptable **for this demo only**: low quotas, and resettable via `db:seed --reset-usage`. Say so in the report.
The admin key is never bundled.

## 3b. Built (Phase 7)

- Gateway CORS (`hono/cors`) allows `CORS_ORIGINS`, headers `authorization`, `content-type`, `x-api-key`, and exposes `x-request-id`; preflights are answered before auth.
- `VITE_*` are read from the repo-root `.env` (`envDir: "../.."`). If `VITE_DEMO_TENANTS` is unset, `vite.config.ts` derives it from `SEED_KEY_ACME/GLOBEX/TINY` (public demo tenants only; the reviewer key is never bundled).
- Run state is a pure reducer over the SSE events (`src/lib/run-state.ts`), so the inspector shows exactly what the gateway reported.
- Demo deep link for the video and screenshots: `/playground?tenant=acme&mode=support&q=…&force_fail=ollama&embedding_outage=1&mock_fail=1&run=1`. It accepts demo tenant **names** only, never keys.
- Screenshots (local profile, Ollama `gemma4:e2b-mlx`, 2026-10-06) in `docs/img/`: `playground-answer.png`, `playground-fallback.png`, `playground-lexical-fallback.png`, `playground-refusal.png`, `usage.png`, `request-detail.png`.
- Found through the screenshots: equal-distance KB entries could show dense ranks out of order (`#5` before `#4`); the window function now uses the same `id` tie-break as the ORDER BY.

## 4. Quality bar

- Clean, neutral UI. Tailwind defaults, one accent colour, readable monospace for metrics. Works at 1280 px wide (the video size). Mobile is not a goal.
- Empty, loading and error states for each panel.
- No component tests required. One Playwright smoke test is P2.

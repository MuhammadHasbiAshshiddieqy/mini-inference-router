# 03 — Architecture

## 1. Component view

```
 ┌───────────── Console (Vue 3 SPA) ─────────────┐        ┌── any "product team" client (curl, eval script) ──┐
 │ Playground · Usage · Request inspector         │        │                                                    │
 └──────────────┬─────────────────────────────────┘        └────────────────────┬───────────────────────────────┘
                │  HTTPS + Bearer <tenant key>  (SSE via fetch stream)          │
                ▼                                                               ▼
 ┌──────────────────────────────── Gateway (Hono, Node.js) ─────────────────────────────────────┐
 │ request-id → error handler → body/size validation → auth (tenant) → quota reserve            │
 │                                                                                              │
 │  /v1/chat ───────────────┐                  /v1/support/answer ───────────────┐              │
 │                          ▼                                                    ▼              │
 │                  Router (plan → execute)  ◄──────────── Support assistant (retrieve → gate → │
 │                  candidates · timeouts ·                 prompt → parse → confidence)         │
 │                  fallback · escalation                                                        │
 │                          │                                                                   │
 │        ┌─────────────────┼──────────────────┐                                                │
 │        ▼                 ▼                  ▼                                                │
 │   Gemini adapter    Ollama adapter     Mock adapter         Metering (requests, route_attempts)
 └────────┬─────────────────┬──────────────────┬──────────────────────────────┬─────────────────┘
          ▼                 ▼                  │                              ▼
   Google Gemini API   Ollama (host/Docker)    (in-process)        Postgres + pgvector (Neon / Docker)
                                                                  tenants · requests · route_attempts · kb_entries
```

## 2. Request lifecycle: `POST /v1/support/answer`

1. **request-id** middleware: generate a UUIDv7 `request_id` and set the `x-request-id` response header.
2. **Body validation** (Zod): JSON only, `message` 1–2000 chars after trim, `max_output_tokens` ≤ tenant cap, optional `debug` block. Failure → 400 `invalid_request` (no LLM call).
3. **Auth**: `Authorization: Bearer <key>` (or `x-api-key`). SHA-256 the key, then look up `tenants.api_key_hash`. Missing → 401 `missing_api_key`. Unknown → 401 `invalid_api_key`. Disabled → 403 `tenant_disabled`.
4. **Quota reserve** (atomic, see §5). Insufficient → 429 `quota_exceeded`, with a `requests` row (outcome `quota_exceeded`). DB error → 503 `quota_unavailable` (fail closed).
5. Open the **SSE stream**. Send a `meta` event.
6. **Retrieve** (doc 05 §2): normalize + embed the query, then `dense` or `hybrid` (dense + pg_trgm, RRF) top-k (k=5). If embedding fails → `lexical_fallback` (trigram only). Send a `retrieval` event including `mode`.
7. **Pre-LLM gate**: if `top1_similarity < T_oos`, emit `refusal` (reason `low_retrieval_similarity`), skip the LLM, go to step 11.
8. **Router plan** → candidate list (tenant policy, capabilities, priority).
9. **Router execute**: try candidates in order. Each attempt emits `route`, and on failure `attempt_failed`. Fallback happens **only before the first token is sent to the client**.
10. **Parse** the model stream: header `INTENT: <label>` then `---` then the answer.
    - Invalid header → abort the attempt, **escalate once** (see doc 05) → still invalid → refusal `unusable_model_output`.
    - Valid → compute confidence → `intent` event → if refuse: abort generation and send a `refusal` event; else stream `token` events.
11. **Reconcile quota** with the actual tokens. **Write metering** (`requests` final row, all `route_attempts`). Send `done`. Close the stream.
12. Client disconnect at any point → abort upstream (AbortSignal), record outcome `client_aborted`, reconcile quota with the tokens actually consumed.

`POST /v1/chat` is the same minus steps 6, 7 and 10: the messages go straight to the router, and tokens stream through.

## 3. HTTP API

All JSON. All `/v1/*` routes require a tenant key. All `/admin/*` routes require `Authorization: Bearer <ADMIN_API_KEY>`.

| Method & path | Purpose |
|---|---|
| `POST /v1/chat` | Generic chat completion, SSE stream (default) or JSON when `"stream": false` |
| `POST /v1/support/answer` | Support assistant, SSE stream (default) or JSON when `"stream": false` |
| `GET /v1/usage` | Calling tenant's own usage, remaining quota, and policy (`allowed_backends`, `allow_debug`, `max_output_tokens`) |
| `GET /admin/usage` | All tenants: requests, tokens, cost, outcome breakdown, remaining quota |
| `GET /admin/requests?tenant=&limit=50&outcome=` | Recent requests (list) |
| `GET /admin/requests/:id` | One request with all route attempts (fallback inspection) |
| `GET /healthz` | Liveness + config fingerprint (profile, backend ids/models, embedding model). No secrets. |

### Request bodies

```ts
// POST /v1/chat
{
  messages: { role: "system"|"user"|"assistant"; content: string }[];   // 1..20 msgs, total ≤ 8000 chars
  max_output_tokens?: number;      // default 512, capped by tenant.max_output_tokens
  tools?: ToolDecl[];              // passed through; restricts routing to supportsTools backends
  stream?: boolean;                // default true
  debug?: DebugOptions;            // only honoured if tenant.allow_debug, else 403 debug_not_allowed
}
// POST /v1/support/answer
{ message: string; max_output_tokens?: number; stream?: boolean; debug?: DebugOptions }

type DebugOptions = {
  force_fail?: string[];           // backend ids to fail synthetically (status "forced_failure")
  mock_latency_ms?: number;        // 0..20000, overrides mock latency for this request
  mock_fail?: boolean;             // mock backend fails this request
  force_embedding_fail?: boolean;  // simulate embedding outage → lexical fallback (support only)
};
```

Debug overrides are **per request** (not global state) because serverless instances do not share memory.

## 4. SSE contract (`packages/shared/src/sse.ts`, Zod-validated on both ends)

Format: `event: <name>\ndata: <json>\n\n`. Send a heartbeat comment `: ping` every 10 s.

| event | data | when |
|---|---|---|
| `meta` | `{ request_id, tenant, endpoint, profile }` | first |
| `retrieval` | `{ mode:"dense"\|"hybrid"\|"lexical_fallback", entries:[{id,intent,dense_sim,trgm_sim,rrf,dense_rank,lex_rank,instruction,response_preview}], knn_intent, vote_share, top1_similarity }` (scores not applicable in a mode are `null`) | support only |
| `route` | `{ attempt, backend_id, model, reason }` | each attempt start |
| `attempt_failed` | `{ attempt, backend_id, status, error, latency_ms }` | each failed attempt |
| `intent` | `{ llm_intent, final_intent, confidence:{ level:"high"\|"medium"\|"low", score, signals } }` | support only, after header parsed |
| `token` | `{ text }` | streaming answer |
| `tool_call` | `{ name, arguments }` | chat with tools only |
| `refusal` | `{ reason, message }` | support refusal |
| `error` | `{ code, message }` | mid-stream failure (after first token) |
| `done` | `{ outcome, served_by:{backend_id,model}\|null, fallback_fired, escalated, usage:{prompt_tokens,completion_tokens,thinking_tokens,total_tokens,estimated}, latency_ms, ttft_ms, cost_usd, quota:{limit,used,remaining}, decisions:string[] }` (`decisions` = routing exclusions from `router/plan.ts`, doc 04 §4) | always last |

`stream:false` returns one JSON object containing the union of these fields (`answer` = concatenated tokens).

## 5. Quota design (token budget with reservation)

- `tenants.quota_tokens` (budget) and `tenants.used_tokens` (consumed + currently reserved).
- **Reserve** before any LLM work: `reserve = estimate_prompt_tokens + max_output_tokens`.
  For the support endpoint, the prompt estimate includes the KB context (≈ chars/4).
  ```sql
  UPDATE tenants SET used_tokens = used_tokens + $reserve
  WHERE id = $id AND enabled AND used_tokens + $reserve <= quota_tokens
  RETURNING quota_tokens, used_tokens;
  ```
  No row → 429 `quota_exceeded` with `{limit, used, remaining, requested}` in `details`.
- **Reconcile** after completion (success, failure or abort):
  `used_tokens = used_tokens - $reserve + $actual_total_tokens` (sum over **all** attempts, because failed attempts that consumed tokens still cost).
  Run reconcile in `finally`. If reconcile fails, log at error level and keep the reservation (conservative: never refund on uncertainty).
- Refusals before the LLM call reconcile to 0 tokens.
- Embedding calls are not charged to the tenant quota (negligible; noted in the report).
- Concurrency test: quota for exactly N requests, fire 3N in parallel → at most N succeed, the rest get 429.

## 6. Database schema (Drizzle, `apps/gateway/src/db/schema.ts`)

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- trigram similarity for hybrid ranking and lexical fallback (available on Neon; verify)

CREATE TABLE tenants (
  id               text PRIMARY KEY,              -- 'acme'
  name             text NOT NULL,
  api_key_hash     text NOT NULL UNIQUE,          -- sha256 hex
  api_key_prefix   text NOT NULL,                 -- first 8 chars, for logs/UI
  quota_tokens     bigint NOT NULL,
  used_tokens      bigint NOT NULL DEFAULT 0,
  allowed_backends text[] NOT NULL,               -- backend ids
  max_output_tokens int NOT NULL DEFAULT 1024,
  allow_debug      boolean NOT NULL DEFAULT false,
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE requests (
  id                uuid PRIMARY KEY,             -- = request_id
  tenant_id         text REFERENCES tenants(id),
  endpoint          text NOT NULL,                -- 'chat' | 'support'
  profile           text NOT NULL,                -- 'cloud' | 'local' | 'hybrid'
  outcome           text NOT NULL,                -- see §7
  served_backend_id text, served_model text,
  fallback_fired    boolean NOT NULL DEFAULT false,
  escalated         boolean NOT NULL DEFAULT false,
  attempts_count    int NOT NULL DEFAULT 0,
  prompt_tokens     int NOT NULL DEFAULT 0,
  completion_tokens int NOT NULL DEFAULT 0,
  thinking_tokens   int NOT NULL DEFAULT 0,
  total_tokens      int NOT NULL DEFAULT 0,       -- across all attempts
  tokens_estimated  boolean NOT NULL DEFAULT false,
  cost_usd          numeric(12,8) NOT NULL DEFAULT 0,
  latency_ms        int, ttft_ms int,
  intent            text, confidence_level text, confidence_score real,
  retrieved_ids     text[],
  retrieval_mode    text,                         -- 'dense' | 'hybrid' | 'lexical_fallback' (support only)
  error_code        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON requests (tenant_id, created_at DESC);

CREATE TABLE route_attempts (
  id                bigserial PRIMARY KEY,
  request_id        uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  attempt_no        int NOT NULL,
  backend_id        text NOT NULL, model text NOT NULL,
  reason            text NOT NULL,                -- why chosen: 'primary' | 'fallback:<prev_status>' | 'escalation:invalid_output' | 'escalation:intent_disagreement'
  status            text NOT NULL,                -- 'ok' | 'timeout_ttft' | 'timeout_total' | 'rate_limited' | 'upstream_error' | 'network_error' | 'invalid_output' | 'forced_failure' | 'aborted' | 'mid_stream_error'
  error_detail      text,
  prompt_tokens int, completion_tokens int, thinking_tokens int,
  cost_usd          numeric(12,8) NOT NULL DEFAULT 0,
  latency_ms int, ttft_ms int,
  started_at        timestamptz NOT NULL
);

CREATE TABLE kb_entries (
  id              text NOT NULL,                  -- 'bitext-01234'
  embedding_model text NOT NULL,                  -- never mix spaces
  intent          text NOT NULL, category text NOT NULL, flags text,
  instruction     text NOT NULL, response text NOT NULL,
  instruction_norm text NOT NULL,                 -- normalize(instruction), for pg_trgm (doc 05 §2.2)
  embedding       vector(768) NOT NULL,
  PRIMARY KEY (id, embedding_model)
);
CREATE INDEX ON kb_entries (embedding_model);
-- 1,350 rows per model: exact scan is fast enough; no ANN index needed (note in report).
```

The `requests` row is inserted at the start (outcome `in_progress`) and updated at the end. A request that crashes therefore remains visible.

## 7. Outcomes and error codes

Outcomes (`requests.outcome`): `ok`, `ok_after_fallback`, `refused`, `quota_exceeded`, `invalid_request`,
`all_backends_failed`, `partial_error` (mid-stream failure), `client_aborted`, `internal_error`, `in_progress`.

| HTTP | code | meaning |
|---|---|---|
| 400 | `invalid_request` | Zod validation failed (details list the issues) |
| 401 | `missing_api_key` / `invalid_api_key` | auth |
| 403 | `tenant_disabled` / `debug_not_allowed` / `no_allowed_backend` | policy |
| 404 | `not_found` | unknown route (same JSON error shape as every other error) |
| 413 | `payload_too_large` | body > 64 KB |
| 415 | `unsupported_media_type` | not JSON |
| 422 | `tools_unsupported` | tools requested but no allowed backend supports tools |
| 429 | `quota_exceeded` | quota (includes limit/used/remaining) |
| 502 | `all_backends_failed` | every candidate failed before the first token (details list attempts) |
| 503 | `quota_unavailable` | DB unreachable during reservation (fail closed) |
| 503 | `embedding_unavailable` | query embedding failed **and** lexical fallback is disabled (`RETRIEVAL_LEXICAL_FALLBACK=false`); normally the request degrades to `lexical_fallback` instead |
| 500 | `internal_error` | anything else (logged with stack, generic message to client) |

Errors that occur before the SSE stream opens are plain JSON with the status above. After the stream opens, the status is already 200, so errors become `error` + `done` events.

## 8. Environment variables (`.env.example`)

```
PROFILE=local                    # cloud | local | hybrid
PORT=8787
DATABASE_URL=postgres://postgres:postgres@localhost:5432/router
ADMIN_API_KEY=change-me
CORS_ORIGINS=http://localhost:5173
LOG_LEVEL=info

GEMINI_API_KEY=
GEMINI_PRIMARY_MODEL=gemini-3.5-flash
GEMINI_FALLBACK_MODEL=gemini-3-flash-preview
GEMINI_THINKING_LEVEL=minimal     # minimal | low | medium | high
GEMINI_EMBED_MODEL=gemini-embedding-001
GEMINI_TTFT_TIMEOUT_MS=8000
GEMINI_TOTAL_TIMEOUT_MS=30000

OLLAMA_URL=http://localhost:11434 # Docker: http://ollama:11434 · Docker→host Mac: http://host.docker.internal:11434
OLLAMA_CHAT_MODEL=gemma4:e2b-mlx  # native Mac (MLX). Docker container default: gemma4:e2b-it-qat (see doc 12 §4)
OLLAMA_THINK=false                # disable model thinking so the INTENT header comes first
OLLAMA_EMBED_MODEL=nomic-embed-text
OLLAMA_SUPPORTS_TOOLS=true
OLLAMA_TTFT_TIMEOUT_MS=20000
OLLAMA_TOTAL_TIMEOUT_MS=60000

MOCK_LATENCY_MS=300
MOCK_FAIL_RATE=0

LOCAL_COST_PER_1M=0              # optional USD per 1M tokens (input and output) for Ollama, to model local hardware cost; 0 = free

RETRIEVAL_TOP_K=5
RETRIEVAL_MODE=dense              # dense | hybrid. Default decided by the retrieval eval (doc 07 §2b)
RETRIEVAL_CANDIDATES=20           # per-retriever depth before RRF
RRF_K=60
RETRIEVAL_LEXICAL_FALLBACK=true   # trigram-only retrieval when embedding fails
CONFIDENCE_T_OOS=                 # filled by `pnpm calibrate`
CONFIDENCE_T_HIGH=
CONFIDENCE_T_TRGM_OOS=            # lexical-fallback gate; filled by `pnpm calibrate`

SEED_KEY_ACME=                    # demo tenant keys used by db:seed (generated if empty and printed once)
SEED_KEY_GLOBEX=
SEED_KEY_TINY=
SEED_KEY_EVAL=
SEED_KEY_REVIEWER=                # private key, sent only in the submission email
```

Validate with Zod. `GEMINI_*` is required only when the active profile uses Gemini, and `OLLAMA_*` only when it uses Ollama.

## 9. Seeded tenants

| id | allowed_backends | quota_tokens | max_output | allow_debug | purpose |
|---|---|---|---|---|---|
| `acme` | all | 150,000 | 1024 | yes | public demo tenant in the SPA (can force failures) |
| `globex` | fallback model + mock only | 50,000 | 512 | no | demonstrates tenant policy |
| `tiny` | all | 3,000 | 256 | no | demonstrates quota exhaustion quickly |
| `eval` | all | 2,000,000 | 1024 | yes | used by the eval script (local/eval Gemini project only; not seeded on Neon unless needed) |
| `reviewer` | all | 500,000 | 1024 | yes | **private** key for the assessors, sent only in the submission email (doc 12 §6) |

`db:seed` is idempotent (upsert by id). It has a `--reset-usage` flag to zero `used_tokens` before a demo.

## 10. Logging

pino JSON with fields `request_id, tenant_id, route, backend_id, attempt, status, latency_ms`.
Log one line per request start/end and per attempt. Never log message bodies at info level (debug only) and never log raw keys.

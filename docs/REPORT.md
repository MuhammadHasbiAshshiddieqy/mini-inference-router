# Mini Inference Router: Technical Report

**Live:** console ⏳ _pending deploy_ · gateway ⏳ _pending deploy_ · **Repo:** https://github.com/MuhammadHasbiAshshiddieqy/mini-inference-router · **Video:** ⏳ _pending_

> Status (6 Oct 2026): everything below the deploy is built and measured on the local profile. The cloud
> numbers (config A) wait for the Gemini embedding quota to reset (§6); items marked ⏳ are filled in after deploy.

## 1. Summary

A small LLM gateway in TypeScript (Hono on Node, Postgres + pgvector) with one capability on top: a
customer-support assistant over the Bitext dataset. Every request goes through per-tenant key auth, an atomic
token-budget reservation that fails closed, routing with recorded fallback, SSE streaming, and metering of
tokens, latency, cost and outcome. On the local profile (Gemma 4 E2B via Ollama) the assistant reaches
**88.9% intent accuracy** on 27 hard-flag held-out cases (kNN retrieval alone: 100%), refuses **5/5**
out-of-scope messages without calling a model, and streams the first token at **1.13 s p50**. The biggest
trade-off: refusal is gated on a calibrated dense-similarity threshold, which is safe for out-of-scope
traffic but produced **2/27 false refusals** on heavily colloquial or misspelt questions.

## 2. Architecture

```
 Console (Vue SPA) ──┐                         ┌── any client (curl, eval runner)
                     ▼  HTTPS + Bearer key, SSE ▼
 ┌──────────────── Gateway (Hono, Node.js) ─────────────────────────────────────┐
 │ request id → 413/415 → tenant auth → validation + policy → quota reservation  │
 │   /v1/chat ───────────────┐          /v1/support/answer ──────────┐           │
 │                           ▼                                       ▼           │
 │                Router: plan (policy → tools → priority)   retrieve → gate →   │
 │                execute (TTFT/total timers, fallback)      parse → confidence  │
 │        Gemini 3.5 Flash → Gemini 3 Flash → Mock  |  Ollama → Mock             │
 │                                   metering: requests + route_attempts         │
 └───────────────────────────────────────────────────────────────────────────────┘
        Postgres + pgvector (Neon in the cloud, Docker locally): tenants · requests · route_attempts · kb_entries
```

- **Auth → quota → work → metering** is one path for both endpoints (`http/admission.ts`): validation, tenant
  policy and the routing plan run *before* the reservation, so a rejected request never holds tokens.
- **Quota** is one conditional `UPDATE … WHERE used + reserve <= quota RETURNING`, reconciled to the actual
  tokens of all attempts at the end (never refunded on uncertainty).
- **Retrieval** returns the top-5 KB entries; **routing** picks the backend; the **parser** reads the model's
  `INTENT:` header before releasing any text, so a bad header can still be escalated or fall back.
- **Metering** writes one `requests` row per request with a known tenant and one `route_attempts` row per
  backend attempt, before the `done` event is sent.

## 3. Gateway correctness

- **Auth:** `Authorization: Bearer` or `x-api-key`, SHA-256 lookup; keys are never stored or logged (log scan: 0 occurrences).
- **Quota:** a test reserves for exactly N=5 requests and fires 15 in parallel: **exactly 5 succeed**, 10 get `429`, `used_tokens` = 5 × reservation. With the database unreachable, requests get `503 quota_unavailable` and **no backend is called**.
- **Streaming:** typed SSE events validated with one shared Zod schema on both ends (`meta, retrieval, route, attempt_failed, intent, token, tool_call, refusal, error, done`), a 10 s heartbeat, and anti-buffering headers. **Commit point:** fallback happens only before content reaches the client; after the first released token a failure is reported (`error: mid_stream_error`, `done: partial_error`) and never silently retried, because the user has already read part of an answer.

| Input or condition | Result (all covered by tests) |
|---|---|
| no key / unknown key / disabled tenant | 401 `missing_api_key` / 401 `invalid_api_key` / 403 `tenant_disabled` |
| body > 64 KB / not JSON / invalid body | 413 / 415 / 400 `invalid_request` with issue list (metered) |
| `debug` from a tenant without `allow_debug`; output cap exceeded | 403 `debug_not_allowed`; 400 |
| no allowed backend; tools but no tool-capable backend | 403 `no_allowed_backend`; 422 `tools_unsupported` (before any reservation) |
| quota insufficient; database down | 429 `quota_exceeded` {limit, used, remaining, requested}; 503 `quota_unavailable` |
| primary 429 / 5xx / network / TTFT or total timeout | next candidate, attempt reason `fallback:<status>` |
| failure after the first released token | `error` + `done(partial_error)`, no retry |
| every candidate fails | 502 `all_backends_failed` (JSON) or `error` + `done` (SSE) |
| client disconnects | upstream aborted, outcome `client_aborted`, quota reconciled |
| unusable model output | escalate once, then refuse `unusable_model_output` |
| embedding service down | lexical (trigram) retrieval, confidence capped at `medium` |
| KB rows or thresholds missing | 503 `assistant_unavailable`; `/healthz` 503 `degraded` with the fixing command |

Test suite: **202 automated tests** (148 gateway incl. 45 against a real Postgres, 43 shared, 11 scripts) plus
3 opt-in live smoke tests. `scripts/smoke.sh` (10 black-box checks) passes **13/13** against the local profile,
natively and in Docker from a clean clone.

## 4. Routing and fallback

Rules, applied in order by a pure function (`router/plan.ts`); every exclusion is returned in `done.decisions`:

1. **Tenant policy:** only `tenant.allowed_backends` (e.g. `globex` is limited to the fallback model and the mock).
2. **Capability:** a request with tools only goes to backends with `supportsTools`. Owner rule: Gemini ≥ 3 only, because 2.5 Flash tool calling was unreliable; the rule is derived from the model id, so pointing the config at a 2.x model can never enable tools.
3. **Priority:** `gemini-3.5-flash` (GA, best quality per cost, `thinking: minimal` for low TTFT) → `gemini-3-flash` (a different model has a **separate free-tier quota**, so a 429 on the primary usually does not hit it) → `mock` (returns a valid header and the top-1 KB answer: degraded but grounded). Locally: `ollama` → `mock`.

**Fallback** (backend failure: 429, 5xx, network, TTFT timeout, total timeout) moves to the next candidate.
**Escalation** (quality: unparseable header, or the model's intent disagrees with retrieval) retries **once** on
the same backend with `thinking: low` and a format reminder. Both are recorded per attempt
(`reason`: `primary`, `fallback:<status>`, `escalation:<why>`) and visible in the console's attempts timeline
and the request inspector (`docs/img/request-detail.png`).

Known weakness, observed live: both cloud models are from one provider, and on 6 Oct `gemini-3-flash-preview`
answered **503 "high demand"** twice in a row while 3.5 Flash was healthy. A preview fallback can be capacity-limited
exactly when needed; the mock still guarantees an answer, and a non-Google fallback is the obvious next step.

## 5. Models and retrieval

- **Models.** Cloud: `gemini-3.5-flash` primary, `gemini-3-flash-preview` fallback, through `@google/genai` so `thinkingLevel` is always explicit (unset, 3.5 Flash defaults to `medium`) and `thoughtsTokenCount` is billed as output. Temperature is never set (Google's guidance for Gemini 3). Live smoke on 3.5 Flash: TTFT 1.18 s, 53 tokens, $0.000312. Local: `gemma4:e2b-mlx` natively, `gemma4:e2b-it-qat` in Docker (MLX cannot run in a Linux container), `think: false`.
- **Embeddings.** `nomic-embed-text` locally, `gemini-embedding-001` in the cloud, both 768-d and L2-normalized, stored per model (vector spaces never mixed). `gemini-embedding-2` was rejected after a live call: it returned **one** vector for a three-text batch (it treats the array as one multimodal input); the adapter's count check caught it.
- **Retrieval.** Instruction-only embeddings (user text to user text), exact pgvector scan (1,350 rows), top-5, kNN intent vote weighted by dense cosine. **Ranking is separated from gating:** refusal thresholds and votes always use calibrated dense cosine, never RRF scores. Hybrid (dense + `pg_trgm` fused with RRF) is implemented; the hybrid query also returns the true dense top-1 for the gate, because the dense rank-1 entry is not guaranteed to survive into the fused top-k.
- **Retrieval-only eval** (297 in-domain + 20 OOS queries, no LLM, `nomic-embed-text`):

| | dense | hybrid | lexical (fallback) |
|---|---|---|---|
| hit@1 | **96.0%** | 94.9% | 89.9% |
| kNN intent accuracy | **96.6%** | 94.9% | 91.2% |
| kNN accuracy, hard flags (n=165) | **95.2%** | 92.7% | 90.3% |
| kNN accuracy, confusable intents (n=143) | **97.2%** | 94.4% | 93.7% |

  Decision rule (written before the run): adopt hybrid only for +1 pp overall or +3 pp on hard flags without
  worse gate metrics. Hybrid lost on every metric, so **`RETRIEVAL_MODE=dense`** ("measured, no gain"): queries
  are short, placeholders are stripped, and trigram overlap on generic words ("order", "refund") pulls in
  neighbouring intents. The fallback loses ~6 pp hit@1, which is why its confidence is capped at `medium`.
- **Confidence and refusal.** Pre-gate: top-1 below `T_oos` → refuse with no model call. After the header:
  agree with kNN → `high` (vote ≥ 0.6) or `medium`; disagree → escalate once, then refuse only against strong
  evidence (top-1 ≥ `T_high` and vote ≥ 0.8), otherwise answer `medium` with the model's intent.
  Thresholds are calibrated on the dev split only (270 + 15 OOS): `nomic-embed-text` **T_oos 0.668** (in-domain
  recall 98.1%, OOS recall 100%), **T_high 0.787**, trigram **T_trgm_oos 0.428**. The margin is thin: the
  highest OOS top-1 is 0.654. `gemini-embedding-001` thresholds: ⏳ pending (§6).

## 6. Evaluation

**Data.** 27 in-domain cases (one per intent, chosen to carry hard flags: typos, colloquial, offensive,
keyword-only) + 5 handwritten OOS cases, never used for calibration. The dataset is paraphrase-heavy; splits
are deduplicated on normalized instructions, but kNN accuracy is still optimistic. One case = 3.7 pp.

**Method.** `scripts/eval.ts` drives the real HTTP API (streaming, client-side TTFT), no debug overrides.
Answer quality = cosine(answer, gold answer) with one fixed scorer (`nomic-embed-text`) for every config.
The LLM-judge metric was cut (§8).

| Metric | **B: local-ollama** (Gemma 4 E2B) | **A: cloud-minimal** (Gemini 3.5 Flash) |
|---|---|---|
| Intent accuracy (final; refusals count as wrong) | 88.9% | ⏳ |
| kNN-only / LLM-header accuracy | 100% / 96.0% | ⏳ |
| OOS refusal rate (n=5) | 100% | ⏳ |
| In-domain false-refusal rate (n=27) | 7.4% | ⏳ |
| Answer similarity to gold (mean) | 0.895 | ⏳ |
| TTFT p50 / p95 (client) | 1,134 / 1,570 ms | ⏳ |
| Total latency p50 / p95 | 1,542 / 2,367 ms | ⏳ |
| Tokens per LLM request (prompt / completion) | 1,122 / 91 | ⏳ |
| Cost per 1,000 requests (list price) | $0 (local) | ⏳ |
| Escalation / fallback rate | 3.1% / 0% | ⏳ |

Full tables, the per-intent grid and the case list are in [`eval/report.md`](../eval/report.md).

**Interpretation.** Retrieval is not the bottleneck (kNN alone is right on all 27); the two policies around it
are. (1) Two hard-flag questions — "want help trying to edit my addres" (top-1 0.653) and "how long does it take
for a damn article to arrive?" (0.637) — sit just under `T_oos` = 0.668 and are refused before the model runs:
the threshold, calibrated for 98% recall on dev, is strict for misspelt or rude phrasing. (2) "I'm trying to get
my damn bills" — kNN `get_invoice` (right), the model `check_invoice` twice; top-1 0.80 is above `T_high` but the
vote share is under 0.8, so the table answers with the model's intent. Gemma also echoed the prompt's format
lines (`Line 1:`, `Line 2: ---`); the parser now tolerates them, which removed an escalation per affected answer.

**Notable failures:** the three cases above, plus an abort during streaming that was first metered as 0 tokens
(Ollama reports usage only in its final chunk) and is now metered as a labelled estimate.

## 7. Measurement accuracy

- **Tokens** come from the provider (`usageMetadata` for Gemini, `prompt_eval_count`/`eval_count` for Ollama). The mock's are estimated (chars/4) and flagged `tokens_estimated`. An attempt that ends without provider usage after streaming content (abort, timeout) is metered as a flagged estimate, never as 0; attempts that fail before any content get no invented count. Request totals sum **all** attempts, failed ones included.
- **Cost** = (prompt × input + (completion + thinking) × output) / 1e6 with official list prices (3.5 Flash $1.50 / $9.00, 3 Flash $0.50 / $3.00 per 1M), computed in integer units of 1e-8 USD and stored as `numeric(12,8)`. We ran on free tiers, so costs are **list-price equivalents** ("est." in the UI).
- **Latency:** server-side TTFT (first released token, i.e. after the INTENT header) and total latency in every `done` event and row; the eval also measures client-side TTFT and total.

## 8. What I cut (and why)

| Cut | Why | What it would take |
|---|---|---|
| Per-minute rate limiting | The brief asks for a quota; rate limiting adds no new evidence of a correct request path | Token bucket per tenant in Postgres or Redis |
| Console login / RBAC | The console is a demo client; demo keys + an admin key typed into the session | OAuth with roles mapped to tenants |
| Multi-turn memory in the assistant | The brief is single-message; keeps the eval clean | Conversation table + summarisation window |
| Executing tools in the gateway | Tool execution belongs to product teams; the gateway routes and passes tools through | Tool registry + sandboxed executors |
| OpenTelemetry / Langfuse / dashboards | DB metering + the attempts table + the request inspector already make decisions inspectable | OTel spans keyed by request id |
| RAGAS / heavy eval frameworks | Python runtime, many LLM calls per sample; 32 cases are clearer with explicit metrics | — |
| ANN index on pgvector | 1,350 rows: an exact scan takes milliseconds | HNSW when the KB grows |
| Circuit breaker (P2) | Per-instance state only helps warm serverless instances; per-request fallback with timeouts already moves past a failing backend | Breaker state in Postgres, recorded as `skipped_circuit_open` |
| LLM-as-judge metric (P1) | First item of the cut order: free-tier quota on every case, and a Gemini judge grading Gemini answers (self-preference bias) | A judge from another provider on a sample |
| Response caching | Would distort latency and cost measurement | Semantic cache keyed by embedding |
| Charging embedding tokens to quota | Negligible cost; keeps the quota model simple | An embedding usage line in metering |
| Retrieval eval on `gemini-embedding-001` | The free tier allows 1,000 embedded texts per day per project; it was spent on the KB build | Run `pnpm eval:retrieval -- --provider gemini` on a fresh quota day |
| Full Docker mode A run on the owner's Mac | It pulls several GB into a Docker volume; the wiring was verified without the pull (it degrades to lexical + mock as designed) and mode B ran end to end | `docker compose --profile ollama up --build` |

## 9. Trade-offs accepted

- **One provider in the cloud** (two Gemini models + mock): zero cost and consistent behaviour, but correlated failures (seen live: a 503 on the preview fallback). Mitigated only by the mock.
- **Free tiers shape everything:** sequential eval with pauses; the embedding quota (100 texts/min, 1,000/day per project) caps the KB build and the demo's question rate; beyond it, retrieval degrades to lexical instead of failing.
- **No fallback after the first token:** correctness over availability for partially streamed answers.
- **Thresholds calibrated on a small dev split:** per embedding model, and they move with a different KB; the eval shows they are strict on hard-flag phrasing.
- **Paraphrase-heavy data:** intent accuracy is optimistic; hard-flag and OOS cases and separate kNN / LLM numbers counter that.
- **Demo keys in the SPA:** fine for low-quota demo tenants; a private reviewer key goes only in the submission email.
- **Docker on macOS runs Ollama on CPU:** a small default model in the container; native Ollama is recommended for real use.

## 9b. Technology choices

Everything that is assessed (routing, fallback, quota, streaming, metering) is our own code, so no framework
hides it: no LangChain/LlamaIndex/Vercel AI SDK (they abstract exactly that layer and lose per-attempt
records and thinking-token counts), no RAGAS/promptfoo (they do not measure intent accuracy, refusal, latency
or cost), no Langfuse/OTel (they would duplicate the required DB metering), no separate vector DB (1,350 rows fit
in the same Postgres). Full rationale with rejected alternatives: [`docs/11-tech-decisions.md`](11-tech-decisions.md).

## 10. What I would do next

1. **Make the gate less brittle on hard phrasing:** calibrate `T_oos` on a hard-flag dev subset, or gate on two signals (dense top-1 *and* trigram top-1) so a misspelt but lexically close question is not refused.
2. **Trust strong retrieval over a disagreeing model:** when top-1 ≥ `T_high`, answer with the kNN intent after a failed escalation (the `get_invoice` case).
3. **Add a non-Google fallback** (e.g. GitHub Models) to break the correlated-provider risk.
4. **Breaker and quota state shared across instances** (Postgres), and per-minute rate limits per tenant.
5. **A second eval pass with an independent judge** on a larger sample.

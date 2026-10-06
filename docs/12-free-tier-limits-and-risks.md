# 12 — Free-Tier Limits, Local Models and Risk Register

This is the "is the design really ready" check: every free service we depend on, its limits (checked **6 Oct 2026**),
what that means for this system, and the mitigation that is built into the design. Re-verify the numbers marked *verify*
during pre-flight, because providers change free tiers often.

## 1. Vercel (Hobby plan): gateway + console

| Limit | Value | Impact on us | Mitigation in design |
|---|---|---|---|
| Function max duration | **300 s** (default = max on Hobby, Fluid compute) | A streamed answer must finish in < 300 s | Gemini total timeout 30 s; worst case (escalation + fallbacks) ≈ 80 s. Set `maxDuration: 120` explicitly. |
| Function memory | 2 GB / 1 vCPU | Plenty: no models run in the function | Embeddings come from the API and vectors stay in Postgres (nothing heavy bundled) |
| Active CPU | **4 CPU-hours / month** | Waiting on I/O (LLM, DB) is **not** counted, so streaming LLM calls are cheap | Avoid CPU-heavy work in functions (no local embedding, no JSON parsing of large files) |
| Provisioned memory | 360 GB-hours / month | 2 GB × 30 s ≈ 0.017 GB-h per request → ~20k requests | More than enough for demo + reviewers |
| Invocations | 1,000,000 / month | — | — |
| Request/response body | 4.5 MB | Irrelevant (our limit is 64 KB) | — |
| Regions | 1 region; default `iad1` (US) | Latency to Neon Singapore would be terrible | `regions: ["sin1"]` in `vercel.json` |
| **Runtime logs** | **1 hour** retention | Logs disappear quickly | Our **DB metering is the system of record** (requests, route_attempts), not logs |
| **Deployment protection** | Vercel Authentication is available for preview **and** production | If protection is on for production, reviewers hit a Vercel login wall | Check Settings → Deployment Protection: production must be **public**. Share **production domains only**, never preview URLs |
| Over-limit behaviour | Feature paused until 30 days pass | A demo outage would last a month | Usage is far below limits; quotas cap the total traffic (§6) |
| Usage policy | Hobby = personal, non-commercial | An assessment demo is personal/non-commercial | — |
| Serverless lifecycle | Work after the response ends may be frozen | Metering writes after the stream closes could be lost | Write metering **before** sending `done`. For client-abort paths use `waitUntil` from `@vercel/functions` (*verify API*) |
| Response buffering | Compression or proxies can buffer SSE | Tokens would arrive all at once | Headers `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`; never gzip SSE routes; verify with `curl -N` on prod |
| DB connections in Fluid compute | Instances are reused and idle connections can leak | Pool exhaustion on Neon | `pg.Pool({max:3, idleTimeoutMillis: 5000})` + `attachDatabasePool(pool)` from `@vercel/functions` right after creating the pool (supports `pg`; verified 2026-10-06) |

## 2. Neon (Free plan, AWS Singapore)

| Limit | Value | Impact | Mitigation |
|---|---|---|---|
| Compute | **100 CU-hours / project / month**, autoscale up to 2 CU | Only consumed while active; demo + eval use a few CU-hours | Scale to zero keeps usage low |
| Scale to zero | After **5 min** idle; **cannot be disabled** on Free | First request after idle pays a wake-up (sub-second to a few seconds) | Gateway sends `meta` immediately; DB timeouts ≥ 5 s for the first query; README mentions "first request may be slower" |
| Storage | **1 GB / project** | ~1,350 × 2 models × 768 floats ≈ 8 MB of vectors plus metering rows: tiny | — |
| Network egress | 5 GB / month | Tiny responses | — |
| Over-limit | Compute **suspended until next month** | Demo outage | Far below the limits; do not run load tests against Neon |
| Metrics history | 1 day | Neon dashboards are not evidence | Our own tables are |

## 3. Gemini API (free tier)

| Limit | Value | Impact | Mitigation |
|---|---|---|---|
| Scope | Limits are **per Google Cloud project, per model** (not per key) | A second key in the same project does **not** add quota | Use **two projects**: `router-demo` (deployed gateway) and `router-eval` (local eval + embedding builds) |
| Dimensions | RPM, TPM (input), **RPD** | RPD can be low for some models (sources range 20–1,500/day) | **Pre-flight: record the actual RPM/RPD** for `gemini-3.5-flash`, `gemini-3-flash-preview` and the embedding model in AI Studio (`aistudio.google.com/rate-limit`) |
| RPD reset | Midnight **Pacific time** = **14:00 WIB** (PDT, until 1 Nov) | The daily quota refreshes mid-afternoon in Jakarta | Plan eval runs and video recording after 14:00 WIB if quota is tight |
| Separate quota per model | Primary and fallback have independent quotas | This is the basis of the fallback design | 429 on 3.5 Flash → 3 Flash → mock |
| Embedding quota | Every support request = 1 query embedding | Demo capacity is also bounded by embedding RPD | Embedding errors → **lexical fallback** (trigram retrieval, confidence ≤ medium); KB embeddings are built once with batching and cached in git |
| Data use | Free-tier prompts may be used to improve Google products | Fine for a public dataset; not for real customer data | Stated in the report |
| Thinking default | If unset: `gemini-3.5-flash` → `medium`, `gemini-3-flash-preview` → `high` (checked 2026-10-06) | Latency and cost spike | Always send `thinkingLevel` explicitly (`minimal`) |

**Observed 2026-10-06 (generation): the free tier allows only 20 generation requests per day per project per model** (quotaId `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, `quotaValue: 20`) for both `gemini-3.5-flash` and `gemini-3-flash-preview`. This triggers the decision rule below with a wide margin: a full 27-case eval does not fit in one project-day, and the deployed demo can serve ~20 primary + ~20 fallback answers per day before every answer comes from the mock (still answered, labelled MOCK, grounded on the top-1 KB answer). Escalations and failed attempts also count against the 20.

**Observed 2026-10-06 (embeddings):** the free tier limits `embed_content` to **100 embedded texts per minute per project** (quotaId `EmbedContentRequestsPerMinutePerUserPerProjectPerModel-FreeTier`, `quotaValue: 100`); a batch of 50 texts counts as 50. Building the 1,350-row KB therefore takes ~14 minutes (`kb:embed` defaults to 50 texts + 31 s pause for Gemini, and resumes from the cache after a 429). At request time each support question is one embedded text, so the deployed demo can embed at most ~100 questions per minute before falling back to lexical retrieval.

**Observed 2026-10-06:** `gemini-3-flash-preview` returned **503 UNAVAILABLE ("high demand")** on two live smoke calls 20 s apart while `gemini-3.5-flash` answered normally. A preview fallback model can be capacity-limited exactly when it is needed; the mock still guarantees an answer, and the adapter classifies this as `upstream_error` (fallback continues). Owner decision pending on whether to keep it as the fallback.

**Decision rule after pre-flight:** if `gemini-3.5-flash` RPD on the demo project is **< 200**, keep the design but
(1) give the public SPA tenants smaller quotas, (2) run evals only on the eval project, and (3) record the demo video early in the day (WIB) right after a reset.

## 4. Local models (owner's Mac and reviewer Docker)

| Item | Native Mac (owner) | Docker container (reviewers) | Why |
|---|---|---|---|
| Chat model | **`gemma4:e2b-mlx`** (7.5 GB, MLX engine, Apple Silicon only) | **`gemma4:e2b-it-qat`** (≈4.3 GB, GGUF, CPU) | MLX runs only on Apple Silicon (Metal). Docker on macOS is a Linux VM **without Metal**, so the container must use a GGUF tag; the QAT build is the smallest Gemma 4 E2B that keeps quality |
| Embedding | `nomic-embed-text` | `nomic-embed-text` | **Same model in both modes**, so the committed embedding cache and the thresholds work everywhere |
| Gemma 4 capabilities | Native function calling, configurable thinking, 128K context, multimodal | same | `OLLAMA_SUPPORTS_TOOLS=true` |
| Thinking | Disable (`think: false` in the Ollama request; *verify* Gemma 4 support) | same | Keeps the `INTENT:` header as the first output and lowers latency. If thinking text still appears, the parser strips it (it is not forwarded) |
| Sampling | Google recommends temp 1.0, top_p 0.95, top_k 64 | same | Use the defaults. Format adherence of a 2B-effective model is a known risk → measured in eval; escalation + parser handle failures |
| Memory | Mac unified memory (16 GB+ recommended) | **Docker Desktop memory ≥ 8 GB** (Settings → Resources) | Otherwise the container OOM-kills the model; README states it |
| Ollama version | MLX support requires a recent Ollama (MLX engine added in 2026) | `ollama/ollama:latest` | Pre-flight: `ollama --version` |

Pre-flight on the Mac (paste the output into the Phase 0 summary):
```
ollama --version
ollama list            # expect gemma4:e2b-mlx and nomic-embed-text
ollama show gemma4:e2b-mlx   # check capabilities: completion, tools, thinking
curl -s localhost:11434/api/tags | head
```

Env defaults:
```
# native (.env.local)
OLLAMA_URL=http://localhost:11434
OLLAMA_CHAT_MODEL=gemma4:e2b-mlx
# docker-compose default (container)
OLLAMA_CHAT_MODEL=gemma4:e2b-it-qat
OLLAMA_EMBED_MODEL=nomic-embed-text
OLLAMA_THINK=false
```

## 5. Other free services and tools

| Service | Limit / risk | Mitigation |
|---|---|---|
| GitHub (public repo) | Anything in the repo is public (including README demo keys) | Only low-quota demo keys in README/SPA; the **reviewer key** goes in the submission email only |
| Hugging Face datasets | Network access is needed once | Split files committed; reviewers never download |
| Docker Hub pulls | Anonymous pull rate limits | Few images (`pgvector/pgvector`, `ollama/ollama`, `node`, `nginx`) |
| Video hosting (YouTube unlisted / Loom free) | Loom free has length limits (*verify*) | Prefer YouTube unlisted or Google Drive |

## 6. Abuse and exposure model (public demo with a free key)

- Demo keys in the SPA are public, so anyone could burn them. **Total exposure is bounded by the sum of tenant quotas**:
  `acme 150k + globex 50k + tiny 3k + reviewer 500k` tokens. There is no unbounded path to the Gemini key.
- Add a **`reviewer`** tenant (all backends, debug allowed, 500k tokens). Its key is sent only in the submission email,
  so reviewers are unaffected if public demo keys get exhausted.
- The admin key is never in the SPA or README.
- `db:seed --reset-usage` resets public tenants right before submission.
- Gemini quota exhaustion degrades to the fallback model and then mock (still answers, visibly labelled), never to an unhandled error.

## 7. Design maturity checklist (what was re-checked)

| Concern | Status |
|---|---|
| Every requirement R1–R24 maps to code and evidence | ✅ doc 01 |
| Fail-closed quota under concurrency and DB failure | ✅ doc 03 §5, tests in Phase 3 |
| Fallback only before the first token; mid-stream failure semantics | ✅ doc 04 §5 |
| Metering survives serverless lifecycle (write before `done`, `waitUntil` on abort) | ✅ this doc §1 |
| SSE not buffered on Vercel | ✅ headers + prod `curl -N` check |
| Vector spaces never mixed; thresholds per embedding model | ✅ doc 02 §7, doc 05 §7 |
| Hybrid retrieval cannot break calibrated refusal (ranking ≠ gating; dense-weighted votes) | ✅ doc 05 §2.1 |
| Embedding outage (Gemini 429/5xx) degrades to lexical fallback instead of failing | ✅ doc 05 §2.5, smoke check 8 |
| Retrieval mode chosen by evidence with adequate n (297 queries) | ✅ doc 07 §2b |
| Same embedding model in native and Docker | ✅ nomic-embed-text in both |
| MLX vs Docker model difference handled | ✅ §4 |
| Region alignment Vercel ↔ Neon | ✅ `sin1` ↔ Singapore |
| Free-tier quota exhaustion paths | ✅ separate Gemini projects, fallback, mock, bounded tenant quotas |
| Reviewers blocked by Vercel auth or a sleeping DB | ✅ production public; Neon auto-resumes; README note |
| Demo keys public | ✅ bounded quotas + private reviewer key |
| Remaining unknowns (must be verified in pre-flight) | ✅ verified 2026-10-06: Gemini key works (`models.list`: `gemini-3.5-flash`, `gemini-3-flash-preview`, `gemini-embedding-001` present); embedding model = `gemini-embedding-001`; `@google/genai` fields (`thinkingConfig.thinkingLevel` enum, `abortSignal`, `usageMetadata.thoughtsTokenCount`); Ollama `think: false` on Gemma 4; `waitUntil` / `attachDatabasePool` in `@vercel/functions`; `vector` 0.8.x and `pg_trgm` 1.6 on Neon (PG14–18); `regions` + per-function `maxDuration` in `vercel.json`. ⚠️ still open: Gemini RPM/RPD per model (needs AI Studio); whether Vercel zero-config Hono builds `.ts`-extension imports and the workspace package (test on first deploy) |

The remaining unknowns are API details, not architecture. Each one has a fallback that does not change the design.

# 11 — Technology Decisions (and what we deliberately did not use)

Every tool and library in this repo, why it was chosen, and why the obvious alternatives were rejected.
Facts about providers and free tiers were checked in **October 2026**. Sources are at the bottom.
This document feeds the "Model and retrieval choices" and "Trade-offs" sections of `docs/REPORT.md`.

## 0. Guiding principles

1. **What is assessed must be visible in our own code.** Routing, fallback, quota, streaming and metering are the core of the brief
   ("reasoned rather than arbitrary, and observable"; "recorded accurately"). Libraries that abstract exactly these layers are rejected even if they are good tools.
2. **Zero cost, no credit card.** The brief provides no API keys. Every service must work on a free tier without a payment method.
3. **One language at runtime.** The brief says "back end Node js". Everything that runs is TypeScript on Node. The only Python is an offline, one-off data-prep script.
4. **Reviewer-runnable.** A reviewer must be able to (a) open a URL, (b) run everything with only Docker, or (c) use their own Ollama.
5. **One-day scope.** Prefer small, explicit, well-documented tools over frameworks with large surface areas.
6. **Measured beats bigger.** Prefer choices that make measurement accurate (tokens, thinking tokens, latency, cost) over choices that add features.

---

## 1. Language, runtime, repo

| Choice | Why we chose it | Alternatives considered → why not |
|---|---|---|
| **TypeScript (strict) on Node.js ≥ 22** | The brief asks for a Node.js back end. Strict types plus Zod give explicit contracts (`Backend`, `RouteDecision`, SSE events), which matter for "code structure and exception handling". Types can be shared between gateway and console. | **Go** (owner's strongest language): risks being read as non-compliant with "back end Node js"; two languages, two builds, two deploys in one day; Go's strengths (concurrency, binary size) don't matter here because LLM latency dominates. **Plain JavaScript**: loses compile-time contracts that help reviewers and catch bad-output handling bugs. **Python (FastAPI)**: not Node. |
| **Monorepo with pnpm workspaces** | One link for reviewers. Gateway, console, shared types, data, eval and docs are versioned together. pnpm is fast, strict about phantom deps, and supported by Vercel and Docker. | **Separate repos**: harder to review and keep consistent. **npm/yarn workspaces**: workable, but pnpm is stricter and faster. **Turborepo/Nx**: a build orchestrator is unnecessary for 3 packages. |
| **`packages/shared`** (intents, SSE schemas, DTOs) | One Zod definition validates SSE events on the server and in the console, so contract drift is caught at compile time. | Duplicating types in each app: drift and silent UI bugs. |

## 2. Gateway (back end)

| Choice | Why we chose it | Alternatives considered → why not |
|---|---|---|
| **Hono** | Small, Web-standards based, first-class streaming (`streamSSE`). The **same app** runs locally (`@hono/node-server`) and on Vercel with **zero config** (default export from `src/index.ts`). Middleware model fits request-id → auth → quota. | **Express**: older API, no built-in SSE helper, weaker typing. **Fastify**: excellent, but a heavier plugin model and less natural on Vercel zero-config. **NestJS**: DI framework overkill for a 1-day gateway. **Next.js API routes**: ties the gateway to a React framework (we chose Vue), and mixes "gateway" with "console". **Nuxt/Nitro**: one Vue app for both, but blurs the gateway as an independent service, which is the story of the case study. |
| **`@hono/node-server`** (local/Docker runner in `src/local.ts`) | Long-running Node server for Docker and local dev, sharing the exact app object used on Vercel. | Running `vercel dev` locally: adds a Vercel dependency to local and Docker runs. |
| **Zod** | Validation at every boundary: HTTP bodies, env vars (fail fast at boot), LLM-related structures, SSE events, dataset rows. Strong TS inference and readable error lists for `400 invalid_request`. | **Joi/Yup**: weaker TS inference. **Valibot**: smaller bundle but a less familiar API, and bundle size does not matter server-side. **TypeBox/Ajv**: JSON-Schema-first, more ceremony. |
| **pino** | Fast structured JSON logs. Every line carries `request_id` to correlate app logs and inference attempts. | **winston**: slower, more config. **console.log**: unstructured, cannot be filtered or correlated. |
| **Custom `AppError` + one error middleware** | One place maps errors to `{error:{code,message,request_id}}` with a stable code table (doc 03 §7). This is a core assessed point. | Framework default error pages: inconsistent shapes, leaks stack traces. |
| **SSE over HTTP (Hono `streamSSE`)** | One-way token streaming is exactly SSE's use case. It works through Vercel Functions streaming, proxies and `curl -N`. Typed events carry metadata (`route`, `attempt_failed`, `intent`, `done`). | **WebSockets**: bidirectional and unnecessary; not supported by Vercel Functions. **Long polling**: worse UX, cannot show streaming. **Plain chunked text**: no event types, so the console cannot show routing and metrics. |
| **SHA-256 hashed API keys** | Keys are high-entropy random strings, so a fast hash plus lookup by hash is the standard approach (as for API tokens). A DB leak does not reveal keys. | **bcrypt/argon2**: designed for low-entropy passwords; too slow for per-request auth with no security gain here. **Plaintext keys**: unacceptable. |
| **UUIDv7 request ids** | Time-ordered, so it sorts naturally in the `requests` table and logs. | UUIDv4: random order. Auto-increment ids: leak volume and are not usable before the insert. |

## 3. Data layer

| Choice | Why we chose it | Alternatives considered → why not |
|---|---|---|
| **PostgreSQL** | The brief requires metering "stored in a database". Atomic `UPDATE … WHERE used + reserve <= quota RETURNING` gives a race-free, **fail-closed** quota without extra infrastructure. One DB for tenants, metering and vectors. | **SQLite**: no managed free serverless option that works from Vercel functions; file DBs don't fit serverless. **MongoDB**: atomic conditional update is possible, but no native vectors in the free tier and weaker relational joins for attempts. **Redis/Upstash for quota**: a second datastore to keep consistent with metering; Postgres is enough at this scale. |
| **pgvector** (in the same Postgres) | 1,350 KB rows per embedding model, so an exact cosine scan takes milliseconds. Vectors live next to the KB text, are queryable by SQL, and avoid bundling a multi-MB vector file into the Vercel function. Neon supports it; the local image is `pgvector/pgvector`. | **Pinecone/Qdrant/Weaviate/Chroma**: an extra service, account and network hop for 1,350 rows (overengineering). **In-memory JSON vectors in the function**: bundling/size issues on Vercel and a cold-start parse cost. **ANN index (HNSW/IVFFlat)**: unnecessary at this size; exact search is more accurate. Noted as a future step. |
| **Neon** (Free plan, AWS Singapore) | Free, no card; 1 GB storage; **scales to zero and auto-resumes on the next connection** (no manual unpause); pgvector; Singapore is closest to Indonesia and matches Vercel `sin1`. Only the Postgres service is enabled. | **Supabase Free**: project **pauses after 1 week of inactivity and must be restored manually**, and reviewers may open the URL weeks later; 500 MB; extra features (Auth, Storage) unused. **Render Postgres Free**: **expires 30 days after creation**. **Neon AI Gateway / Neon Auth**: would replace the very gateway and auth we are assessed on. |
| **Drizzle ORM + drizzle-kit** | SQL-like, typed, thin; migrations in TS; supports `pgvector` columns and raw SQL where we need precise atomic statements. Works with the standard `pg` driver. | **Prisma**: heavier engine, pgvector only via raw SQL/unsupported types, slower cold starts on serverless. **TypeORM**: decorator-heavy, weaker types. **Kysely**: good query builder, but no schema/migration story as integrated. **Raw SQL only**: fine, but loses typed rows. |
| **`pg` (node-postgres) driver for both local and Neon** | One driver, one code path; Neon's **pooled** connection string works over TCP from Vercel Node functions; `Pool({max:3})` reused across warm invocations. | **`@neondatabase/serverless`**: great for edge runtimes, but a second code path just for the cloud. **postgres.js**: also good; `pg` is the most widely supported by Drizzle and tooling. |
| **Token-budget quota with reservation + reconcile** | Fails closed before any cost is incurred; correct under concurrency; charges failed attempts that consumed tokens. | **Request-count quota**: does not reflect cost. **Post-hoc token counting only**: concurrent requests can overshoot the quota. **In-memory counters**: wrong across serverless instances. |

## 4. LLM backends and models

| Choice | Why we chose it | Alternatives considered → why not |
|---|---|---|
| **Gemini 3.5 Flash** (primary, cloud) | GA and stable; free tier without a card; good quality per cost; **reliable tool calling** (Gemini 3 enforces strict function-response matching); `thinking_level` lets us trade latency for reasoning (`minimal` default, `low` on escalation). | **Gemini 2.5 Flash**: owner tested it and **tool calling failed frequently**, consistent with public reports (malformed function calls, refusals, multi-turn errors). Excluded by policy. **Flash-Lite (2.5/3.1)**: owner decision: Flash only, for answer quality. **Gemini 3.1 Pro Preview**: paid-only. |
| **Gemini 3 Flash (`gemini-3-flash-preview`)** (fallback, cloud) | A different model has a **separate free-tier quota**, so a 429 or model-specific incident on the primary usually does not affect it. Same family, so similar output format and tool-calling reliability. | **Another provider as fallback** (ideal for independence) was evaluated, but none worked without friction: see the rows below. Trade-off documented: correlated provider risk, mitigated by mock. |
| **Mock backend** | Explicitly endorsed by the brief ("easiest way to show fallback working"). Configurable latency and failure; per-request debug overrides make fallback **deterministic in demos**. For support it returns a valid header plus the top-1 KB answer, so it is a grounded degraded mode. | Relying on real outages to demo fallback: not reproducible. |
| **Ollama** (local profile, native Mac or Docker) | Free, offline, OpenAI-like semantics; runs natively on Apple Silicon (Metal) or in a container for reviewers; reports token counts (`prompt_eval_count`, `eval_count`). Gives a real second provider for the eval comparison. | **llama.cpp server**: more manual model management. **LM Studio**: GUI app, not containerizable. **vLLM**: needs an NVIDIA GPU, so no Mac support. **Self-hosting Ollama on a free cloud tier**: no GPU and ~512 MB RAM, so not viable. |
| **Gemma 4 E2B** (`gemma4:e2b-mlx` native Mac, `gemma4:e2b-it-qat` in Docker) | Already installed on the owner's Mac; the **MLX build** uses Apple's MLX engine for fast inference on Apple Silicon; ~2.3B effective params (5.1B with embeddings), 128K context, **native function calling** and configurable thinking. The QAT GGUF build (≈4.3 GB) is the smallest quality-preserving variant for CPU-only Docker. Same family in both modes, so behaviour is comparable. | **MLX tag in Docker**: impossible, because MLX needs Apple Silicon/Metal and Docker on macOS is a Linux VM without Metal. **Larger Gemma 4 (12B/26B)**: too slow on CPU containers and heavy for reviewers. **Qwen3 / Llama 3.x small**: viable alternatives, but the owner already runs Gemma 4 and it supports tools. Any model can be swapped via `OLLAMA_CHAT_MODEL`. |
| **Groq** (not used) | — | Very fast with a free tier, but **the owner could not sign in with Gmail** during setup. Not worth the time risk. Can be added later as one adapter. |
| **Cerebras** (not used) | — | API access requires **adding a payment method** before use ($5 credit). Violates the no-card principle. |
| **OpenRouter free models** (not used) | — | ~**50 requests/day** without credits, which an eval + demo would exhaust. |
| **GitHub Models** (not used) | — | Viable (free with a GitHub PAT), but it would add a second provider integration while the owner chose an all-Gemini cloud for consistency. Listed as the easiest future independent fallback. |
| **Ollama Cloud** (not used) | — | Free tier exists but has **concurrency 1** and undisclosed quotas. Risky as a primary when reviewers test. |
| **Mistral free tier** (not used) | — | Requires opting into training on your data; another integration for little benefit. |

## 5. SDKs and AI frameworks

| Choice | Why we chose it | Alternatives considered → why not |
|---|---|---|
| **`@google/genai`** (official Gemini SDK) | Exposes Gemini 3 specifics we must control and measure: `thinkingConfig.thinkingLevel`, `usageMetadata.thoughtsTokenCount` (thinking is billed as output, needed for accurate cost), `thoughtSignature` for tool calls, `abortSignal`. | **Gemini OpenAI-compatible endpoint + `openai` SDK**: simpler, but thinking controls and thinking-token usage are not exposed with the same fidelity. **Vercel AI SDK**: see below. |
| **`ollama`** (official JS client) | Thin client; streaming; final-chunk token counts; tool support. | Ollama's OpenAI-compatible `/v1`: usage reporting in streams is less consistent; the native API is clearer. |
| **No LangChain / LangChain.js** | The brief asks us to **build** the routing, fallback, streaming and metering layer, which is exactly what LangChain abstracts. Using it would hide the assessed mechanics: `withFallbacks()` gives no per-attempt DB records with reason/status, no TTFT vs total-timeout distinction, and no "no fallback after the first token" guarantee. Token usage normalization across providers is uneven (Gemini thinking tokens can be lost), which hurts cost accuracy. New provider features (Gemini 3 `thinkingLevel`, thought signatures) lag. Heavy dependency tree and fast-moving APIs. | We use ~150 lines of explicit, unit-tested router code instead. Easy to replace later because adapters implement one `Backend` interface. |
| **No LlamaIndex** | Its value is in ingestion pipelines and complex retrieval. Our retrieval is one SQL query over 1,350 rows. | — |
| **No Vercel AI SDK** | Excellent for app developers, but like LangChain it **is** a provider-abstraction and streaming layer, the part we are assessed on. Its unified usage object may not carry thinking tokens per provider exactly. | Could power the console's stream reading, but our SSE contract carries custom events (`route`, `attempt_failed`, `intent`), which a ~60-line fetch reader handles. |
| **Prompt as a versioned constant (`PROMPT_V1`)** | Recorded in the eval fingerprint, so prompt changes are traceable. | Prompt management platforms (Langfuse prompts, PromptLayer): unnecessary for 1–2 prompts. |
| **Structured header (`INTENT: x` + `---`) instead of JSON mode** | Lets us **stream** the answer while still extracting a validated intent first; malformed output is detected early and triggers escalation. | **JSON mode / response schema**: the answer cannot be streamed token-by-token to the user until the JSON closes. **Two calls (classify, then answer)**: double latency and cost. **Function calling for the intent**: unnecessary complexity for a label. |

## 6. Embeddings and retrieval

| Choice | Why we chose it | Alternatives considered → why not |
|---|---|---|
| **Gemini embedding** (cloud), 768-d, `RETRIEVAL_DOCUMENT`/`RETRIEVAL_QUERY` | Same API key and provider as generation; task-type aware; configurable dimensionality (768 keeps storage small; vectors L2-normalized). | Running a local embedding model inside a Vercel function: model download and cold-start cost. Third-party embedding APIs: another key and account. |
| **`nomic-embed-text`** (local), 768-d | Standard Ollama embedding model, small, good quality, same 768 dims as cloud (one table schema). Uses `search_document:`/`search_query:` prefixes. | `mxbai-embed-large` (1024-d): larger, and dims differ from cloud. |
| **Separate vectors per embedding model** (`embedding_model` column) | Vector spaces from different models are incompatible. Tagging prevents silent garbage retrieval. Thresholds are calibrated **per model**. | A single shared index: wrong results when switching profiles. |
| **Embed `instruction` only** | Matches user message to user message (short, similar phrasing); the response is attached as context. | Embedding responses: long, diluted vectors, worse intent matching. |
| **Similarity-weighted kNN intent + LLM intent + agreement** | Two independent signals give a confidence signal grounded in data rather than the model's self-report; disagreement triggers escalation or refusal. | **LLM self-reported confidence**: poorly calibrated. **A trained classifier**: training time, and less explainable in one day. |
| **Thresholds calibrated on a dev split** (`scripts/calibrate.ts`) | Data-driven refusal thresholds that never touch the eval set. | Hand-picked thresholds: arbitrary and hard to defend. |
| **Committed embedding cache** (`data/embeddings/*.f32`) | Reviewers on CPU-only Docker skip re-embedding 1,350 rows; reproducible. | Re-embedding on every setup: slow on CPU and burns free-tier quota. |
| **Hybrid retrieval: dense + `pg_trgm` fused with RRF** (`RETRIEVAL_MODE=hybrid`, default chosen by eval) | Free and already in the same Postgres (one extension, one SQL round-trip). **Character trigrams are tolerant to typos and colloquial spelling**, which this dataset is full of (flags Z/Q/K). RRF fuses ranks, so the two retrievers' incompatible score scales do not need tuning. | **BM25 / Postgres `tsvector` full-text**: token-based, so it misses typos ("cancelation", "oorder") and stemming does little on 47-char queries. **ParadeDB `pg_search` (BM25)**: not available on Neon Free and same token issue. **Elasticsearch/OpenSearch/Typesense**: an extra service for 1,350 rows. **MiniSearch in-process**: fine, but duplicates data outside the DB and must be bundled into the function. **Weighted score sum (α·dense + β·lexical)**: needs scale calibration; RRF does not. |
| **Separate ranking from gating** | RRF scores are rank-based with no absolute meaning, so they **cannot be thresholded for OOS refusal**. Gating stays on the calibrated **dense cosine top-1**; kNN votes are weighted by dense cosine. Lexical overlap ("order", "account", "payment") therefore cannot turn an out-of-domain question into a confident answer. | **Gating on RRF or trigram scores**: silently breaks the refusal mechanism (R14) and needs a second calibration on a small dev set. |
| **Lexical fallback when embedding fails** (trigram only, confidence capped at `medium`) | Turns an embedding outage (429/5xx/timeout) into a **degraded but working** path instead of a 503. It is visible (`retrieval_mode`, console badge) and has its own calibrated gate `T_trgm_oos`. Directly serves "failure behaviour". | **Hard 503 on embedding failure** (earlier design): correct, but less resilient. **A second embedding provider**: another integration and vector space. |
| **Why hybrid was not the original default** | Recorded for honesty: the first design assumed dense was sufficient (placeholders remove exact-match entities, queries are short, KB is small) and prioritised gateway work. On review, hybrid's cost turned out to be tiny in Postgres, but the real concerns were (1) breaking calibrated refusal if RRF were used for gating, (2) spurious lexical matches for OOS queries, (3) double calibration, and (4) an n=27 eval too small to prove a gain. The design addresses all four: separate ranking/gating, dense-weighted votes, one extra threshold only for the fallback, and a 297-query retrieval-only eval. | — |

## 7. Evaluation

| Choice | Why we chose it | Alternatives considered → why not |
|---|---|---|
| **Custom TS eval runner through the gateway HTTP API** | Measures the **real** path (auth, quota, retrieval, routing, streaming) and client-side TTFT. It reports exactly the requested metrics: intent accuracy, answer quality, latency, cost, plus refusal and reliability. Same language as the rest. | **RAGAS**: does not measure intent accuracy, refusal, latency or cost; its faithfulness/relevancy metrics need **many LLM calls per sample**, which hits free-tier RPM limits; Python adds a second runtime. **promptfoo**: good for prompt A/B, but we would still need custom assertions for SSE metadata, intent and cost; extra config DSL. **DeepEval**: Python, LLM-judge heavy. |
| **Semantic similarity with one fixed scorer model** | Cheap, deterministic, comparable across configs. | Per-config scorer: incomparable numbers. BLEU/ROUGE: poor for paraphrased support answers. |
| **LLM-as-judge (P1, Gemini 3.5 Flash)** | Adds a correctness/groundedness view; bias caveat stated. | Human grading: no time. A judge from a different provider: none available for free without friction. |
| **Two configs: cloud vs local (or thinking minimal vs low)** | Directly justifies routing defaults and the escalation design with numbers. | Comparing two near-identical prompts: less informative for a routing gateway. |

## 8. Observability

| Choice | Why we chose it | Alternatives considered → why not |
|---|---|---|
| **DB metering (`requests`, `route_attempts`) + SSE metadata + console request inspector** | The brief requires metering **stored in a database** and fallback decisions **recorded and inspectable**. This is that requirement, built directly, and it doubles as demo evidence. | **Langfuse**: a good LLM-tracing tool with a free option, but it would be a **second copy** of the same data, plus an account, keys, an SDK and a failure mode (trace export). It is not a substitute for the DB requirement. Possible add-on: an optional exporter keyed by `request_id`. **OpenTelemetry**: valuable in production; setup cost without a collector/backend to show. **Helicone/Portkey**: proxy-style gateways that would replace what we are asked to build. **Grafana/Prometheus**: needs hosting; console views suffice. |
| **pino JSON logs with `request_id`** | Correlates logs with DB rows; Vercel shows function logs. | Unstructured logs. |

## 9. Front end (console)

| Choice | Why we chose it | Alternatives considered → why not |
|---|---|---|
| **Vue 3 + Vite + TypeScript** | Listed in the brief; fast dev server; static build deploys anywhere. | **React/Next.js**: allowed by the brief, but Vue aligns with the team. **Nuxt**: SSR not needed for an internal console. |
| **Vue Router** | Three pages (Playground, Usage, Requests). | File-based routing: unnecessary. |
| **Composables for state** | Small app; no global store complexity. | **Pinia**: fine, but not needed at this size (add if state grows). |
| **Tailwind CSS** | Fast, consistent, minimal styling for a clean demo UI without fighting a component library. | **Vuetify/PrimeVue/Element Plus**: heavier, opinionated look, longer setup. Plain CSS: slower to make tidy. |
| **`fetch()` + `ReadableStream` SSE reader** (or `eventsource-parser`) | Can send the `Authorization` header; supports custom events and abort. | **`EventSource`**: **cannot set headers**, so the API key would have to go in the URL (leaks into logs and history). |
| **Demo tenant keys in build env** | Lets reviewers use the deployed console instantly; low quotas, resettable. | Login system: out of scope; cut. |

## 10. Deployment and local runtime

| Choice | Why we chose it | Alternatives considered → why not |
|---|---|---|
| **Vercel** (two projects: gateway, console) | Free, no card; **zero-config Hono**; streaming responses supported; no sleep/cold-wake page like Render Free; region `sin1` matches Neon Singapore; Git-based deploys with preview URLs. | **Render Free**: web services **spin down after 15 min** with ~1 min wake-up (bad for reviewers opening the URL later), and the free Postgres expires after 30 days. **Railway/Fly.io**: free allowances are limited or need a card. **Cloudflare Workers**: different runtime constraints (no `pg` TCP driver without extra setup). |
| **Region `sin1` for functions** | The default region is in the US; every DB round-trip would cross the Pacific and inflate measured latency. | Default region: worse and misleading latency numbers. |
| **Docker Compose with profiles** | One command for reviewers. The `--profile ollama` toggle switches between an Ollama container and the host Ollama (`host.docker.internal`, `extra_hosts` for Linux). One-shot `migrate` service seeds DB and KB from cache. | Requiring reviewers to install Node/pnpm/Postgres/Ollama manually: friction. Kubernetes/Helm: overkill. |
| **Ollama container on CPU for reviewers, native Ollama on Mac for dev** | **Docker on macOS cannot use the Metal GPU**, so native is much faster for development and recording. The container guarantees portability. | Container-only: slow on Mac. Native-only: reviewers must install Ollama. |
| **`pgvector/pgvector:pg16` image** | Postgres with pgvector preinstalled; matches Neon's capability. | Plain `postgres` image: needs pgvector compiled in. |
| **nginx:alpine for the console image** | Tiny static server with SPA fallback. | Node static server: larger image, no benefit. |
| **Optional `docker-compose.gpu.yml`** | NVIDIA reviewers can opt in to GPU. | Making GPU the default: breaks on Mac and Windows without NVIDIA. |

## 11. Tooling and quality

| Choice | Why we chose it | Alternatives considered → why not |
|---|---|---|
| **Node's built-in TypeScript type stripping** (`node src/local.ts`, Node ≥ 22.18) | Runs `.ts` directly in dev and scripts with no extra dependency. Enforced by `erasableSyntaxOnly` + `verbatimModuleSyntax`; imports use `.ts` extensions (`rewriteRelativeImportExtensions` for any later emit). | **tsx / ts-node**: one more dependency for what Node now does natively. **Pre-compiling for dev**: slower loop. |
| **TypeScript 6.0 (pinned `~6.0`)** | typescript-eslint 8.x supports TypeScript `<6.1` (checked 2026-10-06); TypeScript 7 (native Go compiler) has no JS API for the ESLint parser yet. | **TypeScript 7**: faster `tsc`, but breaks typed lint tooling today. |
| **Hand-written UUIDv7** (`http/request-id.ts`, ~15 lines, RFC 9562) | Time-ordered request ids without a dependency; unit-tested for version/variant bits and ordering. | **`uuid` package**: a dependency for one function. **`crypto.randomUUID()`**: v4 only, random order. |
| **Vitest** | Fast, ESM/TS native, fake timers for TTFT/timeout tests, same config style as Vite. | **Jest**: slower ESM/TS setup. **node:test**: fewer conveniences (mocks, timers). |
| **Fake backends + fake timers in tests; opt-in `LIVE=1` smoke** | Deterministic tests of fallback/timeout/bad-output paths without network or quota usage. | Live-only tests: flaky and burn free-tier quota. |
| **ESLint (typescript-eslint, flat config) + Prettier** | Mature support for TS **and Vue SFCs** (`eslint-plugin-vue`). | **Biome**: faster, but Vue SFC support is less complete. |
| **`scripts/smoke.sh` (curl)** | Black-box verification of the deployed URL (auth, quota, streaming, fallback, policy) and great for the video. | Postman collections: less portable, not CLI-native. |
| **Python `datasets` for one-off data prep** | The dataset's canonical loader (the brief's own snippet). Offline only; outputs are committed, so runtime and reviewers never need Python. | **HF datasets-server REST API from Node**: paginated (100 rows per call, ~270 calls) and rate-limited. Downloading parquet in Node: extra deps for a one-time task. |

## 12. Summary: what we did not use, in one table

| Not used | One-line reason |
|---|---|
| LangChain / LlamaIndex / Vercel AI SDK | They abstract the routing/fallback/streaming/metering layer that the assessment asks us to build and measure precisely. |
| RAGAS / DeepEval / promptfoo | They do not measure intent accuracy, refusal, latency or cost; LLM-heavy metrics conflict with free-tier limits; extra runtime/DSL. |
| Langfuse / OpenTelemetry / Helicone / Grafana | The required evidence is DB metering + inspectable attempts; these would duplicate it. Langfuse is a possible optional exporter. |
| Pinecone / Qdrant / Chroma / Weaviate | 1,350 rows: pgvector in the existing Postgres is enough and simpler. |
| BM25 / tsvector / Elasticsearch for hybrid | Token-based matching misses typos; `pg_trgm` in the same Postgres is typo-tolerant and free. |
| Redis / Upstash | Postgres atomic updates already give a correct, fail-closed quota. |
| Prisma | Heavier on serverless; weak pgvector support. |
| Supabase / Render Postgres | Pauses after 1 week (manual restore) / expires after 30 days. |
| Render / Railway / Fly | Sleep-on-idle or card requirements. |
| Gemini 2.5 Flash / Flash-Lite / 3.1 Pro | Unreliable tool calling / owner wants Flash quality / paid-only. |
| Groq / Cerebras / OpenRouter / Ollama Cloud | Sign-in failed / card required / ~50 req/day / concurrency 1. |
| Next.js / Nuxt / NestJS / Express | Vue is preferred; keep gateway independent; NestJS overkill; Express lacks streaming ergonomics. |
| Go for the gateway | The brief says Node; one language and one deploy in one day. |
| WebSockets / EventSource | Unneeded bidirectionality, unsupported on Vercel Functions / cannot send auth headers. |
| bcrypt for API keys | Designed for low-entropy passwords; unnecessary cost for random keys. |

## Sources (checked Oct 2026)

- Hono on Vercel (zero-config entry files, streaming): https://vercel.com/docs/frameworks/backend/hono
- Gemini 3 developer guide (`thinkingLevel`, model ids, temperature, thought signatures): https://ai.google.dev/gemini-api/docs/generate-content/gemini-3
- What's new in Gemini 3.5 Flash (GA, strict function responses, thinking levels): https://ai.google.dev/gemini-api/docs/interactions/whats-new-gemini-3.5
- Gemini 2.5 Flash tool-calling issues: https://github.com/BerriAI/litellm/issues/16651 · https://github.com/BerriAI/litellm/issues/17949 · https://github.com/openclaw/openclaw/issues/138373 · https://discuss.ai.google.dev/t/gemini-2-5-flash-05-20-refusing-to-use-certain-tool-calls/84086 · https://discuss.ai.google.dev/t/very-frustrating-experience-with-gemini-2-5-function-calling-performance/92814
- Gemini free-tier model list and pricing (third-party, verify in AI Studio): https://www.memetik.ai/guides/gemini-api-free-tier-limits · https://costgoat.com/pricing/gemini-api
- Neon vs Supabase free plans: https://neon.com/guides/neon-vs-supabase-free-plan
- Render free tier (sleep, 30-day Postgres): https://justinmckelvey.com/blog/is-render-free
- Free LLM API comparison (OpenRouter, GitHub Models, Mistral, etc.): https://openrouter.ai/blog/tutorials/free-llm-apis-compared/
- Ollama Cloud free tier: https://mvalentsev.github.io/awesome-free-ai-coding/providers/ollama-cloud/
- Groq / Cerebras sign-up outcomes: owner's own attempts (6 Oct 2026).

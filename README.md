# Mini Inference Router

A small **LLM gateway** with one capability on top: a **customer-support assistant** that answers from a
knowledge base built from the Bitext customer-support dataset and returns the detected intent.

Every request goes through per-tenant API-key auth, a token-budget quota that **fails closed**, routing with
**recorded fallback**, **SSE streaming**, and **metering** (model, tokens, latency, estimated cost, outcome) in Postgres.
A Vue console shows what happened: which model answered, whether fallback fired, what was retrieved, the intent,
tokens, latency and cost.

- **New to the code (or to JavaScript)?** Start with the one-day guide in [`learn/`](learn/README.md).
- **Technical report:** [`docs/REPORT.md`](docs/REPORT.md) · **Evaluation:** [`eval/report.md`](eval/report.md)
- **Live:** console https://mini-router-console.vercel.app · gateway https://mini-router-gateway.vercel.app · **Videos:** [technical walkthrough](https://docs.google.com/videos/d/12NTjikhjxePfBKm-jU_RCwF842gjO5h8RrHMXkl_zDk/play?usp=sharing) · [console demo](https://docs.google.com/videos/d/1OYfKRzPvsmi_xMfU-T_1Jfy9c8K-z1s4ZWvvghAQeT8/play?usp=sharing)
- **Public demo keys** (low quotas, reset before submission), also bundled into the console's tenant menu:

  | Tenant | API key | Quota | Policy |
  |---|---|---|---|
  | `acme` | `mir_local_37323db3d674c9c4e5cf0eec4abbe04b` | 150,000 tokens | all backends, debug options |
  | `globex` | `mir_local_0f52cac375b07ab0a69c1c4039f1f0a3` | 50,000 tokens | `gemini-3-flash` + mock only, no debug |
  | `tiny` | `mir_local_24fb112fb8c60ea3942e034bd162d610` | 3,000 tokens | low quota, shows the 429 |

  The first request after idle can take a few seconds (cold start). Gemini's free tier allows 20 generation
  requests per day per model, so after that the deployed demo answers from the labelled MOCK backend.
- **Usage and Requests pages** need the admin key (the `/admin/*` routes are read-only); it is sent privately with
  the submission, never bundled into the console.

## Architecture

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
        Postgres + pgvector (Neon in the cloud, Docker locally)
```

| Profile | Backends (priority) | Embeddings |
|---|---|---|
| `cloud` (deployed) | `gemini-3.5-flash` → `gemini-3-flash` (`gemini-3-flash-preview`) → `mock` | `gemini-embedding-001` |
| `local` | `ollama` (`gemma4:e2b-mlx` native, `gemma4:e2b-it-qat` in Docker) → `mock` | `nomic-embed-text` |

## Run it

Three ways, one codebase. Requirements per mode are listed in each section.

### A. Docker only (reviewer path)

Needs Docker Desktop with **≥ 8 GB memory** (Settings → Resources). The first start pulls the container models
(several GB) into a Docker volume; Ollama runs on CPU in the container, so answers are slow.

```bash
cp .env.example .env            # optional: set SEED_KEY_ACME / _GLOBEX / _TINY to pin demo keys
docker compose --profile ollama up --build
# console http://localhost:5173 · gateway http://localhost:8787
docker compose logs migrate     # prints the generated tenant keys if SEED_KEY_* were empty
```

Until the models are pulled, requests are still answered: retrieval degrades to lexical and generation to the
mock backend, and the attempts timeline shows why.

### B. Docker + native Ollama on a Mac (fast, Metal)

```bash
ollama pull gemma4:e2b-mlx && ollama pull nomic-embed-text   # once
ollama serve                                                  # in another terminal
DOCKER_OLLAMA_URL=http://host.docker.internal:11434 DOCKER_OLLAMA_CHAT_MODEL=gemma4:e2b-mlx \
  docker compose up --build
```

### C. Without Docker for the apps

Needs Node ≥ 22.18, pnpm, a Postgres with pgvector (e.g. `docker compose up -d postgres`) and Ollama.

```bash
pnpm install
cp .env.example .env                                   # set ADMIN_API_KEY and SEED_KEY_* (≥ 20 chars)
docker compose up -d postgres
pnpm db:migrate && pnpm db:seed
pnpm kb:embed -- --provider ollama --from-cache-only   # loads the committed embedding cache, no model call
pnpm dev                                                # gateway :8787 + console :5173
```

Cloud profile locally: `PROFILE=cloud` and `GEMINI_API_KEY` in `.env`, then
`pnpm kb:embed -- --provider gemini` (paced for the free tier: 100 texts/min, 1,000/day per project) and
`pnpm calibrate`.

## API

All `/v1/*` routes need a tenant key (`Authorization: Bearer <key>` or `x-api-key`); `/admin/*` needs the admin key.

```bash
GW=http://localhost:8787; KEY=<tenant key>

# Support assistant, streamed (events: meta, retrieval, route, intent, token…, done)
curl -N $GW/v1/support/answer -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"message":"how do i change my shipping address"}'

# Same, one JSON object: answer, refused, intent {final, llm, knn}, confidence, retrieved, served_by, usage, cost
curl $GW/v1/support/answer -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"message":"Has my refund been processed yet?","stream":false}'

# Force the primary to fail (tenants with allow_debug only) → fallback, recorded per attempt
curl $GW/v1/support/answer -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"message":"Has my refund been processed yet?","stream":false,"debug":{"force_fail":["ollama"]}}'

# Generic chat (SSE by default), with tool pass-through on tool-capable backends
curl -N $GW/v1/chat -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hello in five words."}]}'

curl $GW/v1/usage -H "authorization: Bearer $KEY"                      # own quota, policy, usage
curl $GW/admin/usage -H "authorization: Bearer $ADMIN_API_KEY"          # every tenant
curl $GW/admin/requests/<request_id> -H "authorization: Bearer $ADMIN_API_KEY"   # the fallback record
curl $GW/healthz                                                        # config fingerprint, readiness
```

Debug overrides (`force_fail`, `mock_fail`, `mock_latency_ms`, `force_embedding_fail`) are per request and only
for tenants with `allow_debug`. Error shape: `{ "error": { "code", "message", "request_id", "details?" } }`.

Black-box check of any deployment: `BASE=… KEY=… TINY=… GLOBEX=… ADMIN=… ./scripts/smoke.sh` (10 checks).

## Evaluation (summary)

27 hard-flag in-domain + 5 OOS cases, end to end through the gateway:

| | Local: Gemma 4 E2B (Ollama) | Cloud: Gemini 3.5 Flash |
|---|---|---|
| Intent accuracy on answers from the model | 96.0% (24/25) | 100% (14/14)¹ |
| Intent accuracy overall (refusals = wrong) | 88.9% | 96.3%¹ |
| OOS refusal / in-domain false refusal | 100% / 7.4% | 100% / 3.7% |
| Answer similarity to gold (model answers) | 0.895 | 0.910 |
| TTFT p50, model served first try | 1.13 s | 4.17 s² |
| Cost (list price) | $0 | ~$0.0025 per answer |

¹ The Gemini free tier allows **20 generation requests per day per model**; after that the mock answered (12 of
26), visibly labelled. ² Gemini reported 503 "high demand" during the run.

Retrieval-only (297 queries): dense hit@1 96.0% vs hybrid 94.9% → `RETRIEVAL_MODE=dense`.
Details and caveats (n is small; one case = 3.7 pp): [`eval/report.md`](eval/report.md).

```bash
pnpm eval:retrieval                                     # dense vs hybrid vs lexical, no LLM
pnpm eval -- --label local-ollama --key $SEED_KEY_EVAL  # end to end through a running gateway
pnpm eval:compare -- eval/results/A.json eval/results/B.json   # → eval/report.md
```

## Tests and checks

```bash
pnpm -r typecheck && pnpm -r lint && pnpm -r test
REQUIRE_DB=1 pnpm -r test     # database tests fail (instead of skipping) when Postgres is not running
LIVE=gemini pnpm --filter gateway exec vitest run src/backends/live.test.ts   # opt-in real-provider smoke
```

204 automated tests (45 against a real Postgres: auth, fail-closed quota incl. a 3N-parallel concurrency test,
metering, SSE contract, fallback, escalation, refusal); adapters are tested against responses recorded from
the real providers.

## Repository

```
apps/gateway    Hono API: auth, quota, metering, routing, support assistant
apps/console    Vue 3 console: playground + inspector, usage, request inspector
packages/shared Zod contracts shared by both (intents, SSE events, DTOs, SSE parser)
scripts         data prep (Python, one-off), seed, KB embedding, calibration, eval, smoke test
data            dataset splits, embedding caches, calibrated thresholds (all committed)
eval            results and report
docs            specs (01–12), technical report, screenshots
learn           a one-day guided tour of the code for newcomers
```

Design specs: [`docs/01-requirements.md`](docs/01-requirements.md) (traceability R1–R24) ·
[`docs/03-architecture.md`](docs/03-architecture.md) · [`docs/04-routing-and-backends.md`](docs/04-routing-and-backends.md) ·
[`docs/05-support-assistant.md`](docs/05-support-assistant.md) · [`docs/11-tech-decisions.md`](docs/11-tech-decisions.md) ·
[`docs/12-free-tier-limits-and-risks.md`](docs/12-free-tier-limits-and-risks.md).

## Data and license

Knowledge base and evaluation cases come from the
[Bitext customer-support dataset](https://huggingface.co/datasets/bitext/Bitext-customer-support-llm-chatbot-training-dataset)
(CDLA-Sharing 1.0), split by `scripts/prepare_data.py` at a pinned revision (`data/split_manifest.json`).
The 20 out-of-scope messages are handwritten.

Notes: on the free Neon plan the database scales to zero, so the first request after idle can take a few seconds.
Costs are list-price equivalents; the deployment runs on free tiers.

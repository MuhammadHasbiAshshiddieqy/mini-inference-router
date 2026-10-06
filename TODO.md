# TODO — Mini Inference Router

Consolidated, actionable checklist built from `CLAUDE.md` and `docs/01`–`docs/12`.
`docs/01-requirements.md` remains the source of truth; `docs/09-execution-plan.md` holds the canonical phase checkboxes.
Tick items here **and** in `docs/09` at the end of each phase.

**Deadline:** Fri 9 Oct 2026, 13:00 WIB · **Target submit:** before 12:00 WIB (1 h buffer).

| When | Phases | Exit criterion |
|---|---|---|
| Day 1 (Tue PM – Wed) | 0–6 | Support answer streams end-to-end locally with fallback + metering + quota; all tests green |
| Day 2 (Thu) | 7–10 | Console done, eval on 2 configs, Docker works, deployed to Vercel + Neon |
| Day 3 (Fri AM) | 11–12 | Report, README, video, prod smoke test, submit |

Working rules (from `CLAUDE.md`): phases in order · stop and summarise after each phase · no scope beyond the docs ·
verify external facts before hardcoding (`// source: <url>, checked <date>`) · never weaken a failure path ·
no new dependency without a row in `docs/11` and owner approval · every cut logged in `docs/10` Part B.

---

## Pre-flight

Done by Claude (2026-10-06):
- [x] GitHub repo exists (public, still empty) and `origin` is linked
- [x] Docker Desktop memory ≈ 8 GB (VM reports 7.75 GiB), 11 CPUs, Engine 29.6.2
- [x] Ollama 0.32.5 running; `gemma4:e2b-mlx` (completion, tools, thinking; 5.2B, 128K ctx) and `nomic-embed-text` present
- [x] Container model `gemma4:e2b-it-qat` is not needed on the Mac: Docker's `ollama-pull` service fetches it into its own volume; tested in Phase 10
- [x] Python ≥ 3.10 available: Homebrew 3.14 and uv 3.12 (`/usr/bin/python3` is 3.9 → call `python3.12` or `uv run` explicitly)
- [x] pnpm installed (12.9.1, global via npm; Node 26 ships without corepack)

Owner only (accounts and keys; Claude cannot do these):
- [ ] Two Google AI Studio projects: `router-demo` (Vercel) and `router-eval` (eval + embedding builds); put the eval key in `.env` as `GEMINI_API_KEY`
- [x] Gemini key in `.env` works; `models.list` shows `gemini-3.5-flash`, `gemini-3-flash-preview`, `gemini-embedding-001` (2026-10-06). Embedding model decided: `gemini-embedding-001` (`gemini-embedding-2` returns one vector per batch)
- [ ] Record actual RPM / RPD per model per project in `docs/12` §3; apply the decision rule (RPD < 200 → smaller SPA quotas, eval only on eval project, record video right after 14:00 WIB reset)
- [ ] Neon project (Singapore, Postgres only), pooled connection string saved (needed by Phase 9; local Docker Postgres covers Phases 2–8)
- [ ] Vercel account linked to GitHub (needed by Phase 9)
- [ ] Read `docs/12` once end-to-end

## External facts verified (2026-10-06, sources in docs/04, docs/08, docs/12)

- [x] `@google/genai`: `config.thinkingConfig.thinkingLevel` (enum `ThinkingLevel.MINIMAL|LOW|MEDIUM|HIGH`), `config.abortSignal` (client-side only: usage is still billed), `usageMetadata.thoughtsTokenCount`
- [x] Both Gemini models support `minimal`; if unset, 3.5 Flash defaults to `medium`, 3 Flash Preview to `high`; keep temperature default
- [x] Gemini pricing: `gemini-3.5-flash` 1.50 / 9.00, `gemini-3-flash` 0.50 / 3.00 per 1M (re-check before final eval)
- [x] Ollama: `think: false` works on `gemma4:e2b-mlx` (no `thinking` field); `nomic-embed-text` = 768 dims; JS client `abort()` aborts all streams of one client → one client per attempt
- [x] `@vercel/functions`: `waitUntil(promise)` and `attachDatabasePool(pool)` (supports `pg`)
- [x] Neon: `vector` 0.8.x and `pg_trgm` 1.6 on PG14–18
- [x] Vercel Hobby: one region (`regions: ["sin1"]`), 300 s default and max duration, per-function `functions.<path>.maxDuration`; Hono entry `src/index.ts` detected
- [ ] Vercel zero-config Hono builds `.ts`-extension imports and the `@mir/shared` workspace package → test on the first deploy (Phase 9); fallback is a build step
- [ ] Phase 6 risk: with a minimal prompt Gemma 4 E2B wrote `Line 1: INTENT: Cancel Order` (echoed "Line 1:", label not snake_case). Test the real `PROMPT_V1` early; the parser and escalation must handle it

---

## Phase 0 — Repo bootstrap
- [x] pnpm workspace: `apps/gateway`, `apps/console` (placeholder until Phase 7), `packages/shared`
- [x] `tsconfig.base.json` (strict), ESLint flat config (typescript-eslint; `eslint-plugin-vue` added with the console in Phase 7), Prettier, Vitest
- [x] Root scripts from `CLAUDE.md` "Commands" (stubs OK)
- [x] `.env.example` (doc 03 §8), `.gitignore`, `.nvmrc` (22)
- [x] `packages/shared`: `intents.ts` (27 + `out_of_scope`), `sse.ts` (Zod for all events, doc 03 §4), `api.ts` (DTOs)
- [x] Gateway: `create-app.ts`, `index.ts` (default export), `local.ts` (`@hono/node-server`), `GET /healthz`, request-id (UUIDv7), error middleware + `AppError`, pino, `config/env.ts` (Zod, fail fast)
- **Verify:** `pnpm -r typecheck && pnpm -r lint && pnpm -r test`; `curl localhost:8787/healthz`
- **Commit:** `chore: bootstrap monorepo`

## Phase 1 — Dataset split (docs/02)
- [x] `scripts/prepare_data.py` + `scripts/requirements.txt` (`datasets`, `huggingface_hub`)
  - seed 42, shuffle within intent, eval first (first row with flags in `ZQKWE`), then dev, then kb
  - normalized-instruction dedup across splits; ids `bitext-<index>`
  - asserts: 27 intents, exact counts per intent, no overlap; summary table
  - `split_manifest.json` incl. dataset revision sha
- [x] Hand-write `data/eval_oos.jsonl` (5, fixed list in doc 02 §5) and `data/dev_oos.jsonl` (15, no duplicates)
- **Verify:** counts 1350 / 270 / 27; no overlap; print 3 sample eval rows
- **Commit:** `feat(data): stratified KB/dev/eval split`

## Phase 2 — Database (docs/03 §5–6, §9)
- [x] Drizzle schema + migrations: `tenants`, `requests`, `route_attempts`, `kb_entries` (`instruction_norm`, `vector(768)`), extensions `vector` + `pg_trgm`
- [x] `packages/shared/src/normalize.ts` + tests on the same fixtures as the Python version
- [x] `db/client.ts`: lazy `pg.Pool({ max: 3, idleTimeoutMillis: 5000 })`, SSL when required
- [x] `docker-compose.yml` with `postgres` only (`pgvector/pgvector:pg16`)
- [x] `scripts/seed.ts`: idempotent tenants `acme`, `globex`, `tiny`, `eval`, `reviewer`; hashed keys + prefix; `--reset-usage`; print generated keys once
- [x] `embeddings/gemini.ts` (768-d, task types, L2-normalize) and `embeddings/ollama.ts` (prefixes, L2-normalize)
- [x] `scripts/embed_kb.ts`: `--provider gemini|ollama`, batching + delay + resume, cache `data/embeddings/<model>.f32` + `.meta.json` (sha256 of kb.jsonl), `--from-cache-only`, upsert
- [ ] Phase 9: call `attachDatabasePool(pool)` (`@vercel/functions`) when running on Vercel; needs a docs/11 row
- [x] Gemini embedder verified live (768 dims, batch of 3, sim(query, cancel)=0.736 vs OOS 0.506); embedding model id settled
- [ ] `pnpm kb:embed -- --provider gemini` (≈27 batch calls) — waiting for owner: confirm the key is from `router-eval`
- **Verify:** 1350 rows for `nomic-embed-text`; top-5 for "i want to cancel my order" = cancel_order; trigram on "cancel my oorder" ranks cancel_order highest
- **Commit:** `feat(db): schema, seed, KB embeddings in pgvector`

## Phase 3 — Auth, quota, metering skeleton (docs/03 §2–7)
- [x] Middleware: 64 KB body limit (413), JSON only (415), auth Bearer / `x-api-key` → sha256 lookup (401 / 403 `tenant_disabled`)
- [x] `quota/reserve.ts` (atomic UPDATE … RETURNING; 429 `quota_exceeded` with details; DB error → 503 `quota_unavailable`) and `quota/reconcile.ts` (in `finally`; never refund on uncertainty)
- [x] `metering/`: insert `requests` row as `in_progress`, record attempts, finalize; cost from `config/pricing.ts` (`numeric(12,8)`)
- [x] Routes: `GET /v1/usage`, `GET /admin/usage`, `GET /admin/requests`, `GET /admin/requests/:id`
- **Tests:** 401 missing/invalid · 403 disabled · 400 · 413 · 415 · 429 + row · DB down → 503, no backend call · concurrency (quota N, 3N parallel → ≤ N succeed) · reconcile math
- **Commit:** `feat(gateway): auth, fail-closed quota, metering`

## Phase 4 — Backends + router (docs/04)
- [x] `backends/types.ts`, `mock.ts`, `ollama.ts`, `gemini.ts`, `registry.ts`; `config/profiles.ts` (cloud / local / hybrid), `config/pricing.ts` (with source + date)
- [x] Error classification: 429 → `rate_limited`, 5xx / provider 400 / empty stream → `upstream_error`, network → `network_error`
- [x] `router/plan.ts` (pure): tenant policy → tools capability → priority; decisions recorded
- [x] `router/execute.ts`: TTFT + total timers (cleared in `finally`), commit point, abort propagation, attempt rows, `force_fail`
- [x] Ollama boot check (`/api/tags`) + background warm-up; `/healthz` reachability (no LLM calls)
- **Tests:** `plan.test.ts`, `execute.test.ts` (ok, 429, TTFT timeout, total timeout, network, forced, after-first-token → `partial_error`, all fail, client abort), `pricing.test.ts`, adapter fixture tests, opt-in `LIVE=1` smoke
- **Commit:** `feat(router): backends, routing rules, fallback with recorded attempts`

## Phase 5 — `/v1/chat` streaming (docs/03 §3–4)
- [ ] `http/sse.ts` on Hono `streamSSE`: typed events, 10 s heartbeat, anti-buffering headers, no compression, metering before `done`, `waitUntil` on abort
- [ ] `routes/chat.ts`: validate → reserve → plan → execute → `token` / `tool_call` → reconcile → `done`; `stream:false` variant
- [ ] Debug overrides only for `allow_debug` tenants (else 403 `debug_not_allowed`)
- **Verify:** `curl -N` with Ollama streams incrementally; force-fail ollama → mock; DB rows correct
- **Tests:** event order; mid-stream failure → `error` + `done(partial_error)`; client abort → upstream aborted + `client_aborted`
- **Commit:** `feat(chat): streaming chat endpoint`

## Phase 6 — Support assistant (docs/05)
- [ ] `assistant/retrieve.ts`: `dense`, `hybrid` (RRF SQL), `lexical_fallback` (on embedding failure after 1 retry or `force_embedding_fail`); gating always on dense cosine
- [ ] `intent.ts` (dense-weighted kNN, vote_share), `prompt.ts` (`PROMPT_V1`), `parse.ts` (HEADER → BODY state machine), `confidence.ts` (decision table), `answer.ts` (escalation), `routes/support.ts`
- [ ] Startup checks: KB rows for active embedding model + `pg_trgm` installed
- [ ] `scripts/calibrate.ts` → `data/thresholds.json` (`T_oos`, `T_high` per model; `T_trgm_oos` under `trigram`) for `nomic-embed-text`
- **Tests:** `normalize`, `retrieve` (hybrid typo, dense-max gating, lexical cap at medium, "order a pizza" pre-gated), `parse` (all fixtures), `confidence` (every row), `support.route` (event order, pre-gate = 0 backend calls + 0 tokens, invalid → escalate → ok, invalid twice → `unusable_model_output`, disagreement, forced-fail → mock)
- **Verify:** curl runs: easy, typo, confusable, OOS (no LLM call), injection
- **Commit:** `feat(assistant): RAG support answer with intent, confidence, refusal`
- **→ Day 1 checkpoint:** show owner curl transcript + DB rows

## Phase 7 — Console (docs/06)
- [ ] Vue 3 + Vite + TS + Vue Router + Tailwind; `lib/sse.ts` (fetch stream, Zod-validated, Stop button)
- [ ] `/playground`: tenant dropdown + custom key (sessionStorage), mode switch, debug controls (if `allow_debug`), example chips, placeholder chips, refusal card, inline error
- [ ] Inspector: served by + badges, attempts timeline, intent + confidence, retrieved (mode badge, scores), metrics ("est."), raw events, link to request
- [ ] `/usage` (admin key in sessionStorage, auto-refresh 10 s), `/requests/:id` (+ list if time)
- **Verify:** manual run-through with Ollama and forced failures; screenshots in `docs/img/`
- **Commit:** `feat(console): playground, usage, request inspector`

## Phase 8 — Evaluation (docs/07)
- [ ] `scripts/eval-retrieval.ts`: dense vs hybrid vs lexical over 297 + 20 queries (nomic); apply decision rule → set `RETRIEVAL_MODE` default; record outcome for report
- [ ] `scripts/eval.ts` (sequential, delay, retry once on 429, fingerprint from `/healthz`, `eval/results/<label>.json`) and `scripts/eval-compare.ts` → `eval/report.md`
- [ ] Optional P1: LLM judge (`--judge`)
- [ ] Run config B `local-ollama`
- **Commit:** `feat(eval): end-to-end eval runner and comparison`

## Phase 9 — Cloud + deploy (docs/08 §2–3)
- [ ] Neon: migrate, seed, `kb:embed --provider gemini`, `calibrate` (cloud); commit caches + thresholds
- [ ] Vercel gateway project (root `apps/gateway`, `sin1`, `maxDuration: 120`, env, CORS) and console project (root `apps/console`, SPA rewrite, build env)
- [ ] Deployment Protection off for production
- [ ] `scripts/smoke.sh` (10 checks)
- [ ] Run eval config A `cloud-minimal` → `eval:compare` → `eval/report.md`
- **Verify:** smoke all PASS on prod; `curl -N` streams; private window without Vercel login; Neon cold wake succeeds
- **Commit:** `feat(deploy): cloud profile on Vercel + Neon, eval results`

## Phase 10 — Docker full stack (docs/08 §1)
- [ ] `apps/gateway/Dockerfile` (deps → build → tools → runtime, non-root, HEALTHCHECK); `apps/console/Dockerfile` (nginx SPA)
- [ ] Compose: `migrate` one-shot, `ollama` + `ollama-pull` profile, `gateway`, `console`; `docker-compose.gpu.yml`
- **Verify:** clean clone → `docker compose --profile ollama up --build` → console :5173 answers; mode B with host Ollama
- **Commit:** `feat(docker): one-command local stack`

## Phase 11 — Report + README (docs/10)
- [ ] `docs/REPORT.md` from template with real numbers; "What I cut" complete; trade-offs; tech-choices summary
- [ ] `README.md`: live URLs + demo keys, 3 ways to run, diagram, curl examples, eval table, report + video links, dataset license (CDLA-Sharing 1.0), "first request may be slow" note, Docker ≥ 8 GB note
- **Commit:** `docs: technical report and README`

## Phase 12 — Video + submit
- [ ] `db:seed --reset-usage` before recording; record per `docs/10` Part D (6–8 min); upload unlisted; link in README
- [ ] `db:seed --reset-usage` on Neon; final `smoke.sh` PASS; tag `v1.0.0`
- [ ] Submission checklist (`docs/10` Part E), incl. `git log -p | grep -i "AIza"` empty
- [ ] Reply to recruiter with repo, URL, report, video, reviewer key (draft in `docs/10` Part F)

---

## Cut order if behind (log each in `docs/10` Part B)

1. LLM-judge metric → 2. circuit breaker → 3. `hybrid` profile → 4. `/requests` list page → 4b. `hybrid` retrieval mode → 5. GPU compose override → 6. `stream:false` on `/v1/chat`

**Never cut:** auth, quota, streaming, fallback + attempt recording, metering, refusal, eval on 2 configs, deploy.

## Doc gaps noticed while reading (resolved)

- [x] `.claude/commands/phase.md` added (run phases with `/phase <n>`).
- [x] `LOCAL_COST_PER_1M` added to `.env.example` list in `docs/03` §8.
- [x] `eval:compare`, `eval-retrieval.ts`, `eval-compare.ts` added to `CLAUDE.md` commands and repo layout.
- [x] `gemini-3-flash` price filled in `docs/04` §7 (0.50 / 3.00 per 1M, official pricing page, checked 2026-10-06).

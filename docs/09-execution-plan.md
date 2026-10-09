# 09 — Execution Plan

Setup of the slash command: the file `.claude/commands/phase.md` lives in a **hidden folder** (name starts with a dot).
In macOS Finder press **Cmd+Shift+.** to show it, or copy it with the terminal: `mkdir -p .claude/commands && cp <download>/phase.md .claude/commands/`.
Restart Claude Code (or reload the VS Code window) and type `/phase` to confirm that it appears.

How to use this with Claude Code: run `/phase <n>` (see `.claude/commands/phase.md`), or paste
"Execute Phase <n> of docs/09-execution-plan.md". Claude must read `CLAUDE.md` plus the docs listed for that phase, implement,
run the verification, tick the boxes below, commit, and **stop** with a short summary and any proposed cuts.

## Timeline (deadline Fri 9 Oct 2026, 23:59 WIB)

| When | Phases | Exit criterion |
|---|---|---|
| Day 1 (Tue PM – Wed) | 0–6 | Support answer streams end-to-end locally with fallback + metering + quota, all tests green |
| Day 2 (Thu) | 7–10 | Console done, eval run on 2 configs, Docker works, deployed to Vercel + Neon |
| Day 3 (Fri AM) | 11–12 | Report, README, video, smoke test on prod, submit **before 12:00** (1 h buffer) |

**Cut order if behind** (cut from the top, and log each cut in the report):
1. LLM-judge metric (keep semantic similarity) → 2. circuit breaker → 3. `hybrid` profile → 4. `/requests` list page (keep the detail page)
→ 4b. `hybrid` retrieval **mode** (keep dense + lexical fallback; the retrieval eval then compares dense vs lexical only)
→ 5. GPU compose override → 6. `stream:false` mode on `/v1/chat`. **Never cut**: auth, quota, streaming, fallback + attempt recording, metering, refusal, eval on 2 configs, deploy.

## Pre-flight (owner, manual, ~30 min)

- [x] GitHub repo `mini-inference-router` created (public or reviewer-accessible). *(public, checked 2026-10-06)*
- [x] Gemini API key from AI Studio. *(2026-10-06: key works; `models.list` confirms `gemini-3.5-flash`, `gemini-3-flash-preview`, `gemini-embedding-001`. RPD observed from real 429s and recorded in `docs/12` §3: 20 generation requests/day/project/model; embeddings 100 texts/min, 1,000/day.)* In AI Studio confirm: `gemini-3.5-flash` and `gemini-3-flash-preview` available on the free tier, their RPM/RPD, and the embedding model ID. Test it:
  `curl "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY" | grep -E '"name": "models/gemini-3'`
- [x] Neon project (Singapore, Postgres only). Pooled connection string saved.
- [x] Vercel account (CLI login; projects deployed with the CLI, not through the GitHub integration).
- [x] Mac: Docker Desktop running with **≥ 8 GB memory**. Ollama up to date (`ollama --version`). Models: `gemma4:e2b-mlx` and `nomic-embed-text` (already on the Mac, confirm with `ollama list` and `ollama show gemma4:e2b-mlx`). The container model `gemma4:e2b-it-qat` is **not** pulled on the Mac: the `ollama-pull` service fetches it into the Docker volume, and it is tested in Phase 10.
- [x] ~~Two Google AI Studio projects~~ **cut**: one Gemini key serves the local eval and Vercel; the free-tier limits (docs/12 §3) were recorded from real 429s. Logged in `docs/REPORT.md` §8.
- [ ] Read `docs/12-free-tier-limits-and-risks.md` once end-to-end.
- [x] Python 3.10+ available for the one-off data prep. *(Homebrew 3.14 and uv 3.12; `/usr/bin/python3` is 3.9, so call `python3.12` / `uv run` explicitly)*

---

## Phase 0: Repo bootstrap
Read: `CLAUDE.md`, `docs/03` §8.
- [x] pnpm workspace: `apps/gateway`, `apps/console`, `packages/shared`. Root `tsconfig.base.json` (strict), ESLint (typescript-eslint, flat config), Prettier, Vitest config.
- [x] Root scripts from CLAUDE.md "Commands" (stubs allowed where later phases fill them in).
- [x] `.env.example` (doc 03 §8), `.gitignore` (node_modules, dist, .env*, keep `.env.example`), `.nvmrc` (22).
- [x] `packages/shared`: `intents.ts` (27 + `out_of_scope`), `sse.ts` (Zod schemas for every event in doc 03 §4), `api.ts` (request/response DTOs).
- [x] Minimal Hono app: `GET /healthz`, request-id middleware, error middleware, `AppError`, pino logger, env parsing with Zod. `src/index.ts` exports the app; `src/local.ts` serves it.
**Verify:** `pnpm -r typecheck && pnpm -r lint && pnpm -r test` green; `pnpm --filter gateway dev` → `curl localhost:8787/healthz`.
**Commit:** `chore: bootstrap monorepo`

## Phase 1: Dataset split
Read: `docs/02`.
- [x] `scripts/prepare_data.py` + `scripts/requirements.txt` exactly per spec. Run it.
- [x] Hand-write `data/eval_oos.jsonl` (5) and `data/dev_oos.jsonl` (15).
- [x] Commit `data/*.jsonl` + `split_manifest.json`.
**Verify:** script assertions pass; counts 1350/270/27; no normalized overlap; print 3 sample eval rows.
**Commit:** `feat(data): stratified KB/dev/eval split`

## Phase 2: Database
Read: `docs/03` §5, §6, §9.
- [x] Drizzle schema + migrations (incl. `CREATE EXTENSION vector` and `pg_trgm`, column `instruction_norm`, `requests.retrieval_mode`). Shared `normalize()` in `packages/shared` with tests matching the Python version. `pg` Pool client (lazy, `max: 3`, SSL when the URL demands it).
- [x] `docker-compose.yml` with just `postgres` for now (pgvector image).
- [x] `scripts/seed.ts`: idempotent tenants (doc 03 §9) with hashed keys; `--reset-usage`; prints generated keys once.
- [x] `scripts/embed_kb.ts`: providers `gemini` | `ollama`, batching + delay + resume, cache `.f32` + meta, `--from-cache-only`, upsert into `kb_entries`.
- [x] Embedding adapters `embeddings/gemini.ts`, `embeddings/ollama.ts` (normalize, task types/prefixes).
**Verify:** `docker compose up -d postgres && pnpm db:migrate && pnpm db:seed && pnpm kb:embed -- --provider ollama` → 1350 rows for `nomic-embed-text`. A SQL top-5 query for "i want to cancel my order" returns cancel_order rows; `similarity(instruction_norm, 'i want to cancel my oorder')` ranks cancel_order rows highest.
**Commit:** `feat(db): schema, seed, KB embeddings in pgvector`

## Phase 3: Auth, quota, metering skeleton
Read: `docs/03` §2–§7.
- [x] Middleware: body size limit (64 KB), JSON content-type, auth (Bearer / x-api-key → sha256 lookup), tenant on context.
- [x] `quota/reserve.ts` + `quota/reconcile.ts` (atomic SQL; fail closed → 503).
- [x] `metering/`: insert `requests` row at start (`in_progress`), record attempts, finalize; cost calc from `config/pricing.ts`.
- [x] `GET /v1/usage`, `GET /admin/usage`, `GET /admin/requests`, `GET /admin/requests/:id` (admin key).
**Tests:** 401 missing/invalid; 403 disabled; 400 invalid body; 413; 415; quota exceeded → 429 + row; **DB down → 503 and no backend call**; concurrency (quota for N, 3N parallel → ≤ N succeed); reconcile math.
**Commit:** `feat(gateway): auth, fail-closed quota, metering`

## Phase 4: Backends + router
Read: `docs/04`.
- [x] `backends/types.ts`, `mock.ts`, `ollama.ts`, `gemini.ts` (**verify SDK fields and model IDs first**; cite sources in comments), `registry.ts`, `config/profiles.ts`, `config/pricing.ts`.
- [x] `router/plan.ts` (pure) and `router/execute.ts` (fallback loop, TTFT/total timers, commit point, abort propagation, attempt recording).
- [x] Ollama boot check + warm-up. `/healthz` shows backend reachability (cheap checks only; no LLM calls on health).
**Tests:** all of doc 04 §8 with fake backends and fake timers. Opt-in `LIVE=1` smoke for Gemini and Ollama.
**Commit:** `feat(router): backends, routing rules, fallback with recorded attempts`

## Phase 5: `/v1/chat` streaming
Read: `docs/03` §3–§4.
- [x] `http/sse.ts` helper on Hono `streamSSE` (typed events, heartbeat, abort handling, anti-buffering headers per doc 12 §1). Metering is finalized before `done`; the abort path uses `waitUntil` when running on Vercel.
- [x] `routes/chat.ts`: validate → reserve → plan → execute → stream `token`/`tool_call` → reconcile → `done`. `stream:false` variant.
- [x] Debug overrides honoured only for `allow_debug` tenants.
**Verify:** `curl -N` against local with Ollama: tokens arrive incrementally; force-fail ollama → mock serves; DB rows correct.
**Tests:** event order contract; mid-stream failure → `error` + `done(partial_error)`; client abort → upstream aborted + `client_aborted`.
**Commit:** `feat(chat): streaming chat endpoint`

## Phase 6: Support assistant
Read: `docs/05`.
- [x] `assistant/retrieve.ts` with modes `dense` | `hybrid` (RRF SQL, doc 05 §2.4) | `lexical_fallback` (on embedding failure or `debug.force_embedding_fail`); ranking separated from gating (doc 05 §2.1).
- [x] `intent.ts`, `prompt.ts` (PROMPT_V1), `parse.ts`, `confidence.ts`, `answer.ts` (orchestration incl. escalation), `routes/support.ts`.
- [x] `scripts/calibrate.ts` → `data/thresholds.json` with dense `T_oos`/`T_high` per embedding model + `T_trgm_oos` (run for `nomic-embed-text` now; Gemini in Phase 9).
**Tests:** doc 05 §9 (normalize, retrieve incl. hybrid/gating/lexical fallback, parser fixtures, confidence table, route tests).
**Verify:** 5 console-free curl runs: in-domain easy, typo, confusable, OOS (pre-gate refusal, 0 LLM calls), injection.
**Commit:** `feat(assistant): RAG support answer with intent, confidence, refusal`
**→ End of Day 1 checkpoint: show the owner a full curl transcript and the DB rows.**

## Phase 7: Console
Read: `docs/06`.
- [x] Vue app scaffold, Tailwind, router, `lib/sse.ts`, shared schemas.
- [x] Playground + inspector; Usage page; Request detail page (+ list if time).
**Verify:** manual run-through of every inspector section with Ollama and with forced failures; screenshot to `docs/img/`.
**Commit:** `feat(console): playground, usage, request inspector`

## Phase 8: Evaluation
Read: `docs/07`.
- [x] `scripts/eval-retrieval.ts` (doc 07 §2b): dense vs hybrid vs lexical over 297 + 20 queries with nomic. **Apply the decision rule and set the `RETRIEVAL_MODE` default**; record the result for the report.
- [x] `scripts/eval.ts`, `scripts/eval-compare.ts`, shared SSE parser reuse.
- [x] Run config B (`local-ollama`) now. Config A runs after Phase 9 (needs Gemini embeddings and thresholds).
**Commit:** `feat(eval): end-to-end eval runner and comparison`

## Phase 9: Cloud profile + deploy
Read: `docs/08` §2–§3.
- [x] Neon: migrate, seed, `kb:embed --provider gemini --from-cache-only` (no calibration run needed: cache and thresholds were committed). *(9 Oct 2026: 1,350 rows, 4 tenants, PG 18.6, vector 0.8.6, pg_trgm 1.6)*
- [x] Vercel gateway + console projects, env vars, `sin1`, CORS, `maxDuration: 120`, Deployment Protection off for production. `scripts/smoke.sh`. *(9 Oct 2026, as a plain function; see docs/08 "As deployed")*
- [x] Run eval config A (against the deployed or a local cloud-profile gateway; record which) → `eval:compare` → `eval/report.md`. *(local cloud-profile gateway, 2026-10-06; Gemini's 20 requests/day/model free-tier cap limited run 1 to 14 Gemini answers)*
**Verify:** `smoke.sh` all PASS against prod. SSE streams incrementally on prod (`curl -N`). The production URL opens in a private window without a Vercel login. Neon wakes from scale-to-zero and the first request still succeeds.
**Commit:** `feat(deploy): cloud profile on Vercel + Neon, eval results`

## Phase 10: Docker full stack
Read: `docs/08` §1.
- [x] Dockerfiles (gateway multi-stage with `tools` + `runtime` targets; console nginx), `migrate` one-shot, `ollama` + `ollama-pull` profile, `docker-compose.gpu.yml`.
**Verify:** from a clean clone: `docker compose --profile ollama up --build` → console at :5173 answers (after model pull). Mode B works with host Ollama.
**Commit:** `feat(docker): one-command local stack`

## Phase 11: Report + README
Read: `docs/10`.
- [x] `docs/REPORT.md` from the template with real numbers; "What I cut" complete; trade-offs honest.
- [x] `README.md`: what it is, live URLs + demo keys, 3 ways to run, architecture diagram, API examples (curl), eval summary table, link to the report and video, dataset license.
  *(2026-10-06: written with measured local numbers; URLs, demo keys, video and the cloud config A column are marked ⏳ until Phase 9 completes.)*
**Commit:** `docs: technical report and README`

## Phase 12: Video + submit
- [x] Record per the script in `docs/10`. Upload (YouTube unlisted / Loom / Drive). Link in README. *(Google Vids + Slides, linked in README/REPORT)*
- [ ] `db:seed --reset-usage` on Neon. Final `smoke.sh` PASS. Tag `v1.0.0`.
- [ ] Reply to the recruiter's email with repo, URL, report link and video link (draft in `docs/10`).

# CLAUDE.md — Mini Inference Router

This file is the project memory for Claude Code. Read it fully at the start of every session.

## What this project is

A take-home technical assessment ("Code Challenge: Mini Inference Router").
We build a small **LLM gateway** plus one capability on top of it: a **customer-support assistant**
that answers from a knowledge base built from the Bitext customer-support dataset and returns the detected intent.

- Deadline: **Friday 9 Oct 2026, 13:00 WIB (UTC+7)**: 3 calendar days from receipt. The work itself is scoped as about one day of effort.
- Deliverables: GitHub repo (code + docs), deployed URL, technical report, video demo.
- Reviewers judge: correctness of the request path, reasoned and observable routing/fallback, accurate measurement,
  code structure and exception handling, and **judgement: what we built, what we skipped, and whether we said so**.

The full requirement text and traceability matrix are in `docs/01-requirements.md`. **That file is the source of truth.**

## Document map (read the relevant one before each phase)

| File | Purpose |
|---|---|
| `docs/01-requirements.md` | Original requirements, IDs R1–R24, traceability to code/tests/evidence |
| `docs/02-dataset.md` | Dataset facts, split strategy, data-prep script spec |
| `docs/03-architecture.md` | Components, request lifecycle, DB schema, API + SSE contract, error model |
| `docs/04-routing-and-backends.md` | Backend interface, profiles, routing rules, fallback vs escalation, pricing |
| `docs/05-support-assistant.md` | Retrieval, intent, confidence, refusal, prompt, output parsing |
| `docs/06-console.md` | Vue console spec |
| `docs/07-evaluation.md` | Eval set, metrics, runner, two-config comparison |
| `docs/08-deployment.md` | Local (Docker / native Ollama) and cloud (Vercel + Neon) setup |
| `docs/09-execution-plan.md` | Ordered phases with acceptance criteria and progress checkboxes |
| `docs/10-report-and-demo.md` | Technical report template, cut list, demo video script, submission checklist |
| `docs/12-free-tier-limits-and-risks.md` | Free-tier limits (Vercel, Neon, Gemini), local model choices (MLX vs Docker), abuse model, risk register |
| `learn/` | One-day onboarding guide to the codebase for newcomers (keep it in sync when behaviour or file names change) |
| `docs/11-tech-decisions.md` | Why each tool/library was chosen and why alternatives (LangChain, RAGAS, Langfuse, …) were rejected. Check it before adding any dependency |

## Working rules

1. **Execute phases in order** from `docs/09-execution-plan.md`. At the end of a phase, run its verification
   commands, tick its checkboxes, commit, and **stop and summarise** for the owner before starting the next phase.
2. **Do not add scope** beyond the docs. If something seems necessary but is not specified, propose it and wait for approval.
   If something specified turns out too costly, propose a cut. Every cut gets logged in `docs/10-report-and-demo.md` → "What I cut".
3. **Verify external facts before hardcoding** (model IDs, SDK field names, prices, free-tier limits, Vercel behaviour).
   Check official docs. Put each value in config with a comment: `// source: <url>, checked <YYYY-MM-DD>`.
4. **Never weaken a failure path to make a test pass.** Auth, quota and fallback must fail closed and loudly.
   Respect the free-tier constraints in `docs/12` (e.g. metering written before `done`, SSE anti-buffering headers, `sin1` region).
5. Keep code explicit and small. The reviewers read the code. Avoid magic frameworks.
6. Language: code, comments, commit messages and repo docs in **English**.
7. **No new dependency without a row in `docs/11-tech-decisions.md`** (choice, reason, alternatives rejected). Ask the owner first.

## Fixed decisions (do not revisit without the owner)

- **Monorepo**, pnpm workspaces, **TypeScript strict** everywhere at runtime. Node.js ≥ 22.
- **Gateway**: Hono on Node.js (`apps/gateway`). Same code runs locally (`@hono/node-server`) and on Vercel (zero-config Hono, default export from `src/index.ts`).
- **Console**: Vue 3 + Vite + TypeScript + Vue Router + Tailwind (`apps/console`). It is just another client of the gateway and authenticates with tenant API keys.
- **Database**: Postgres with **pgvector**. Neon (Singapore region) in the cloud, `pgvector/pgvector` Docker image locally. One driver (`pg`) with Drizzle ORM for both.
- **Validation**: Zod at every boundary (HTTP input, env, LLM output, dataset rows).
- **Logging**: pino JSON logs, every line carries `request_id`.
- **Tests**: Vitest.
- **Model policy (owner decision)**:
  - Cloud uses **Gemini 3+ Flash models only**: primary `gemini-3.5-flash`, fallback `gemini-3-flash-preview` (verify IDs in AI Studio). **No Flash-Lite, no 2.x models.**
  - Tool calling is allowed only on backends flagged `supportsTools: true`. For Gemini that means 3.0 and above only, because 2.5 Flash tool calling is unreliable.
  - Use the official `@google/genai` SDK (needed for `thinkingConfig.thinkingLevel` and `usageMetadata.thoughtsTokenCount`). Do not set temperature on Gemini 3 (keep the default of 1.0).
  - Local uses **Ollama** (native Mac or Docker container), via the official `ollama` npm package. Chat model: **`gemma4:e2b-mlx`** natively on the Mac, **`gemma4:e2b-it-qat`** in Docker (MLX cannot run in a container). Embeddings: **`nomic-embed-text`** in both. `think: false`.
  - Two Gemini projects/keys: `router-demo` (deployed) and `router-eval` (eval + embedding builds). Free-tier limits are per project per model.
  - A **Mock** backend with configurable latency and failure exists in every profile.
- **Embeddings**: Gemini embedding in the cloud, `nomic-embed-text` in local. Both produce 768-dim vectors stored in pgvector, tagged by `embedding_model`. **Never mix vector spaces.**
- **Retrieval**: `dense` (pgvector) or `hybrid` (dense + `pg_trgm` fused with RRF), chosen by the retrieval eval; `lexical_fallback` (trigram only) when embedding fails. **Ranking is separated from gating**: refusal thresholds and kNN votes always use dense cosine (doc 05 §2.1). Never threshold on RRF scores.
- **Data prep**: one offline Python script (`scripts/prepare_data.py`, uses `datasets`). Everything at runtime is Node.

## Explicitly out of scope (already decided, do not build)

Next.js, LangChain/LlamaIndex, RAGAS, OpenTelemetry/Langfuse/Grafana, separate vector DB services,
Neon AI Gateway or Neon Auth, user login/RBAC for the console, per-minute rate limiting, response caching,
multi-turn memory for the support assistant, executing tools inside the gateway (we route and pass tools through only),
Kubernetes. These are listed in the report's "What I cut" section with reasons.

## Repo layout (target)

```
mini-inference-router/
├─ CLAUDE.md
├─ README.md
├─ docker-compose.yml  docker-compose.gpu.yml  .env.example
├─ apps/
│  ├─ gateway/            # Hono API: auth, quota, metering, routing, assistant
│  │  └─ src/
│  │     ├─ index.ts      # export default app (Vercel entry)
│  │     ├─ local.ts      # @hono/node-server runner for local/Docker
│  │     ├─ create-app.ts # builds the Hono app (routes + middleware). Do NOT name it app.ts/server.ts: Vercel scans those names as entries
│  │     ├─ config/       # env.ts (Zod), profiles.ts, pricing.ts
│  │     ├─ http/         # middleware (request-id, auth, error), sse.ts
│  │     ├─ routes/       # chat.ts, support.ts, usage.ts, admin.ts, health.ts
│  │     ├─ quota/        # reserve/reconcile
│  │     ├─ metering/     # request + attempt recording, cost calc
│  │     ├─ backends/     # types.ts, gemini.ts, ollama.ts, mock.ts, registry.ts
│  │     ├─ router/       # plan.ts (candidate selection), execute.ts (fallback loop)
│  │     ├─ assistant/    # retrieve.ts, intent.ts, prompt.ts, parse.ts, confidence.ts, answer.ts
│  │     ├─ embeddings/   # gemini.ts, ollama.ts
│  │     └─ db/           # schema.ts, client.ts, migrations/
│  └─ console/            # Vue 3 + Vite
├─ packages/shared/       # shared types + Zod schemas (SSE events, API DTOs, intents)
├─ data/                  # kb.jsonl, dev.jsonl, eval.jsonl, eval_oos.jsonl, dev_oos.jsonl, split_manifest.json
├─ scripts/               # prepare_data.py, requirements.txt, seed.ts, embed_kb.ts, calibrate.ts,
│                         # eval.ts (end-to-end), eval-compare.ts, eval-retrieval.ts (no LLM), smoke.sh
├─ eval/
│  ├─ results/            # <label>.json (end-to-end), retrieval-<embedding>.json (committed)
│  └─ report.md           # generated by eval:compare (+ retrieval table)
└─ docs/                  # these specs + REPORT.md
```

## Commands (keep these working; add to root package.json)

```
pnpm install
pnpm dev                 # gateway (8787) + console (5173) in parallel
pnpm -r typecheck
pnpm -r lint
pnpm -r test
pnpm db:migrate          # drizzle migrations (uses DATABASE_URL)
pnpm db:seed             # tenants + KB rows
pnpm kb:embed -- --provider gemini|ollama   # embeds KB into pgvector (cached in data/embeddings/)
pnpm calibrate           # computes retrieval thresholds (dense + trigram) from dev split
pnpm eval:retrieval -- --embedding nomic-embed-text   # dense vs hybrid vs lexical, no LLM calls
pnpm eval -- --label <name>                 # end-to-end eval against a running gateway → eval/results/<name>.json
pnpm eval:compare -- eval/results/A.json eval/results/B.json   # → eval/report.md
python scripts/prepare_data.py              # one-off dataset split (needs network + `datasets`)
docker compose --profile ollama up --build  # full local stack incl. Ollama container
```

## Coding conventions

- `strict: true`, no `any`. Use `unknown` and narrow it.
- Errors: throw `AppError(code, httpStatus, message, details?)`. A single error middleware maps it to `{ error: { code, message, request_id } }`. No empty `catch`.
- Every outbound call (LLM, embedding, DB) has a timeout via `AbortSignal`. Timeouts are configurable via env.
- Config: all env vars parsed once by Zod in `config/env.ts`. Startup fails fast with a readable message.
- Secrets never in code or logs. Log API keys only as the hashed prefix.
- Pure functions for routing decisions, confidence and parsing so they are unit-testable without network.
- Money: compute cost in USD with prices per 1M tokens and store as `numeric(12,8)`. Never use float for stored money.

## Definition of done (per phase)

Typecheck, lint and tests pass. Acceptance criteria in `docs/09` are met and demonstrated with command output.
Docs are updated if behaviour changed. Checkboxes are ticked. Conventional commit made.

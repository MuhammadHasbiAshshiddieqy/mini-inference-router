# 03 · Tooling and commands (≈ 45 min)

## The tools, and why each one is here

| Tool | What it does here | You need it for |
|---|---|---|
| **Node.js ≥ 22.18** | Runs JavaScript/TypeScript on the server. Since 22.18 it can run `.ts` files directly ("type stripping") | everything |
| **pnpm** | Installs dependencies and runs scripts across the workspace | everything |
| **TypeScript (`tsc`)** | *Checks* types. It does not build anything here (`noEmit`) | `pnpm -r typecheck` |
| **Vitest** | Test runner | `pnpm -r test` |
| **ESLint / Prettier** | Lint (find bugs and forbidden patterns) / format code | `pnpm -r lint`, `pnpm format` |
| **Docker + Compose** | Runs Postgres (and optionally the whole stack) in containers | the database |
| **Ollama** | Runs open models locally (`gemma4:e2b-mlx`, `nomic-embed-text`) | the local profile |
| **Vite / vue-tsc** | Dev server and build for the console / type-check `.vue` files | the console |
| **drizzle-kit** | Generates SQL migrations from `db/schema.ts` | only when you change the schema |
| **Python 3.10+** | One offline script that split the dataset (already done; output is committed) | almost never |

### "Where is the build step?"

There is none for the gateway and the scripts. `node src/local.ts` runs the TypeScript file directly: Node
removes the type annotations as it loads the file. That is why imports end in `.ts`, and why the TS config
contains `erasableSyntaxOnly` (it forbids the few TS features that cannot simply be erased, like `enum`).
The console *is* built (Vite bundles it into `dist/` for the browser).

## Installing

```bash
corepack enable || npm install -g pnpm   # get pnpm (the repo pins its version in package.json)
pnpm install                             # installs every package's dependencies (see 02-repo-tour)
cp .env.example .env                     # then edit: at least ADMIN_API_KEY; SEED_KEY_* to pin demo keys
```

## Environment variables and `.env`

All settings come from environment variables. The full list, with comments, is [`.env.example`](../.env.example).

- The root scripts start Node with `--env-file-if-exists=.env`, which loads `.env` if it exists. Variables already set in your shell win over the file.
- The gateway reads them **once**, in [`config/env.ts`](../apps/gateway/src/config/env.ts): a Zod schema checks each value, fills defaults, and stops the program with a readable list of problems if something is wrong. `index.ts` hands `process.env` to it once; the rest of the gateway receives the validated `env` object (only test helpers read a few test-only variables such as `REQUIRE_DB` directly).
- Scripts parse only the variables they need ([`scripts/lib/cli.ts`](../scripts/lib/cli.ts)), so they can run in a container that has only `DATABASE_URL`.
- The console reads `VITE_*` variables at **build** time ([`apps/console/vite.config.ts`](../apps/console/vite.config.ts)).

The most important ones:

| Variable | Meaning |
|---|---|
| `PROFILE` | `local`, `cloud` or `hybrid`: which model backends exist |
| `DATABASE_URL` | Postgres connection string |
| `ADMIN_API_KEY` | Key for the `/admin/*` endpoints |
| `GEMINI_API_KEY` | Needed only for `cloud`/`hybrid` |
| `OLLAMA_URL`, `OLLAMA_CHAT_MODEL` | Where Ollama runs and which model to use |
| `SEED_KEY_ACME` … | Fixed API keys for the demo tenants (otherwise `db:seed` generates and prints them) |
| `LOG_LEVEL` | `info` by default; `debug` for more detail |

## Running the system on your laptop

```bash
docker compose up -d postgres                 # 1. database (pgvector image) on port 5432
pnpm db:migrate                               # 2. create tables and extensions
pnpm db:seed                                  # 3. create the 5 demo tenants (prints keys if SEED_KEY_* empty)
pnpm kb:embed -- --provider ollama --from-cache-only   # 4. load 1,350 knowledge-base rows + vectors
ollama serve                                  # 5. in another terminal (models: gemma4:e2b-mlx, nomic-embed-text)
pnpm dev                                      # 6. gateway on :8787 and console on :5173
```

Open http://localhost:5173, pick the `acme` tenant (or paste a key), send a question. Or with curl:

```bash
curl -N localhost:8787/v1/support/answer -H "authorization: Bearer $SEED_KEY_ACME" \
  -H "content-type: application/json" -d '{"message":"how do i change my shipping address"}'
```

`-N` turns off curl's buffering so you see the events arrive one by one.

Without Ollama the gateway still works: the router falls back to the mock backend, and the console shows why.

## Every command

Run from the repository root.

| Command | What it does |
|---|---|
| `pnpm dev` | Gateway (auto-restart on change) + console, in parallel |
| `pnpm --filter gateway dev` | Only the gateway |
| `pnpm -r typecheck` | Type-check every package (`-r` = recursive: run in each package that has the script) |
| `pnpm -r lint` | Lint every package |
| `pnpm -r test` | Run every package's tests |
| `REQUIRE_DB=1 pnpm -r test` | Same, but fail (instead of skip) if Postgres is not running |
| `pnpm format` | Format all files with Prettier |
| `pnpm db:migrate` | Apply SQL migrations ([`scripts/migrate.ts`](../scripts/migrate.ts)) |
| `pnpm db:seed [-- --reset-usage]` | Create/update tenants; optionally reset their used quota |
| `pnpm kb:embed -- --provider ollama\|gemini [--from-cache-only]` | Embed the knowledge base (cached in `data/embeddings/`) and load it into the database |
| `pnpm calibrate [-- --provider …]` | Compute refusal thresholds from the dev split → `data/thresholds.json` |
| `pnpm eval:retrieval` | Compare retrieval modes without calling a model |
| `pnpm eval -- --label <name> --key <eval key>` | End-to-end evaluation through a running gateway |
| `pnpm eval:compare -- a.json b.json` | Write `eval/report.md` |
| `pnpm --filter gateway db:generate` | After editing `db/schema.ts`: generate a new migration |
| `./scripts/smoke.sh` | Black-box check of any running gateway (needs `BASE`, `KEY`, `TINY`, `GLOBEX`, `ADMIN`) |
| `docker compose --profile ollama up --build` | The whole stack in Docker |

`pnpm <script> -- --flag` passes `--flag` to the script. `--filter gateway` picks one package by name (the
`@mir/` scope can be omitted).

## Running one test file

```bash
cd apps/gateway
pnpm exec vitest run src/router/plan.test.ts          # one file
pnpm exec vitest run src/router -t "429"              # tests whose name contains "429"
pnpm exec vitest src/router/plan.test.ts              # watch mode: re-run on every save
```

## Reading the logs

The gateway logs one JSON object per line ([pino](https://getpino.io)). Every line of a request carries the same
`request_id`, which is also returned to the client in the `x-request-id` header and stored as the `requests.id`
in the database. To follow one request: copy its id from the console ("Open request …") and search the logs, or
open `/requests/<id>` in the console.

```json
{"level":30,"request_id":"01a1…","tenant_id":"acme","backend_id":"ollama","attempt":1,"status":"ok","latency_ms":1830,"msg":"attempt"}
```

Level 30 = info, 40 = warn, 50 = error.

## Looking inside the database

```bash
docker compose exec postgres psql -U postgres -d router
router=# \dt                                   -- list tables
router=# SELECT id, outcome, served_backend_id, total_tokens, cost_usd FROM requests ORDER BY created_at DESC LIMIT 5;
router=# SELECT attempt_no, backend_id, reason, status FROM route_attempts WHERE request_id = '<id>';
```

Next: [04 · The gateway, step by step](04-gateway/README.md).

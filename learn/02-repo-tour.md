# 02 · Repository tour (≈ 45 min)

## A monorepo with four packages

This repository is a **monorepo**: several projects that would normally be separate repositories live together,
so they can share code and be changed in one commit. The tool that ties them together is **pnpm workspaces**.

[`pnpm-workspace.yaml`](../pnpm-workspace.yaml) lists where the packages are:

```yaml
packages:
  - apps/*        # apps/gateway, apps/console
  - packages/*    # packages/shared
  - scripts       # scripts
```

| Package name (in its `package.json`) | Folder | Kind | Depends on |
|---|---|---|---|
| `@mir/gateway` | `apps/gateway` | the HTTP server | `@mir/shared`, hono, pg, drizzle-orm, zod, pino, @google/genai, ollama |
| `@mir/console` | `apps/console` | the web app | `@mir/shared`, vue, vue-router, zod |
| `@mir/shared` | `packages/shared` | a library | zod |
| `@mir/scripts` | `scripts` | command-line tools | `@mir/shared`, zod (and gateway code by file path) |
| *(root)* | `/` | not a package; holds shared tools | typescript, eslint, prettier, vitest |

`@mir` is just a prefix we chose ("mini inference router") so our names never clash with public packages.
`"@mir/shared": "workspace:*"` in a `package.json` means "use the copy in this repository, not one from the internet".

## Why are there several `node_modules` folders?

You will find five:

```
node_modules/                     277 MB   ← the real files
apps/gateway/node_modules/         20 KB   ← only links
apps/console/node_modules/        3.5 MB   ← links + Vite's cache
packages/shared/node_modules/       4 KB   ← links
scripts/node_modules/               4 KB   ← links
```

**What `node_modules` is.** When code does `import { Hono } from "hono"`, Node looks for a folder called
`node_modules/hono` — first next to the file, then in each parent folder up to the root. `pnpm install` fills these
folders from the list of dependencies in each `package.json`.

**Why each package has its own.** Each package declares its *own* dependencies. The gateway needs `hono`; the
console does not. So `apps/gateway/node_modules` contains `hono`, and `apps/console/node_modules` does not. This
is deliberate: if the console code ever tried to import `hono`, it would fail immediately instead of
accidentally working. (npm and yarn put everything in one flat folder, which hides such mistakes; pnpm calls
those "phantom dependencies" and prevents them.)

**Why they are tiny.** The per-package folders hold **symbolic links** (shortcuts), not copies:

```
apps/gateway/node_modules/hono   -> ../../../node_modules/.pnpm/hono@4.13.13/node_modules/hono
apps/gateway/node_modules/@mir/shared -> ../../../../packages/shared
```

The real files live once in the root, in `node_modules/.pnpm/` (310 package versions here), named
`<package>@<version>`. Two packages that need the same version share the same files on disk. The link for
`@mir/shared` points straight at our own source folder, so editing `packages/shared/src/*.ts` is visible to the
gateway and the console immediately — no publishing, no copying.

**Why the root has its own tools.** `node_modules/` at the root also holds the tools used by every package
(TypeScript, ESLint, Prettier, Vitest), installed once as root `devDependencies`.

**What you should do with them.** Nothing. Never edit or commit them (`.gitignore` excludes them). If something
looks broken, delete them all and run `pnpm install` again:

```bash
rm -rf node_modules apps/*/node_modules packages/*/node_modules scripts/node_modules && pnpm install
```

## The configuration files at the root

| File | What it configures |
|---|---|
| `package.json` | Root scripts (`pnpm dev`, `pnpm db:migrate`, `pnpm eval` …), root dev tools, required Node version, pnpm version |
| `pnpm-workspace.yaml` | Where the packages are; which packages may run install scripts (`allowBuilds`) |
| `pnpm-lock.yaml` | The exact version of every dependency (never edit by hand; commit it) |
| `tsconfig.base.json` | TypeScript rules shared by all packages (strict mode, modern JS, `.ts` imports) |
| `eslint.config.js` | Lint rules (catches bugs and forbidden patterns such as `any`) |
| `.prettierrc.json`, `.prettierignore` | Automatic code formatting |
| `vitest.config.ts` | Lets `vitest` run every package's tests from the root |
| `.env.example` | Every environment variable, with defaults and comments; copy it to `.env` |
| `.nvmrc` | Node version for tools like `nvm` |
| `docker-compose.yml`, `docker-compose.gpu.yml` | The local stack in containers |
| `.dockerignore` | Files never sent into a Docker build |
| `CLAUDE.md` | Working rules for the AI assistant that built the project — also a good summary of the fixed decisions |
| `TODO.md` | Progress checklist across all phases |

Each package then has its own `package.json` (its dependencies and scripts) and `tsconfig.json` (which
`extends` the base). The shared package has two TypeScript configs: one for its code (no Node types, because the
browser uses it too) and one for its tests (which may use Node).

## The map

Lines in brackets are approximate sizes, to help you decide what to read first.

```
apps/gateway/src/
  index.ts            entry for Vercel: build config + app, export it              (17)
  local.ts            entry for your laptop/Docker: start an HTTP server            (13)
  create-app.ts       ★ wires every middleware and route in order                  (89)
  logger.ts           JSON logging (pino)                                          (21)
  config/             env.ts (all env vars, validated) · profiles.ts (which backends) ·
                      pricing.ts (exact cost maths) · thresholds.ts (refusal thresholds)
  http/               request-id.ts · body.ts (413/415) · auth.ts · admission.ts (validate →
                      reserve → in-progress row; settle) · sse.ts (streaming) · errors.ts ·
                      error-handler.ts · api-keys.ts · types.ts
  quota/quota.ts      atomic reserve + reconcile                                   (79)
  metering/           requests.ts (write rows) · attempts.ts · usage.ts (read views)
  backends/           types.ts (the contract) · mock.ts · gemini.ts · ollama.ts ·
                      registry.ts · ollama-health.ts · fixtures/ (recorded real responses)
  router/             plan.ts (which backends, in what order) · execute.ts (★ fallback loop)
  routes/             health.ts · usage.ts · admin.ts · chat.ts · support.ts
  assistant/          retrieve.ts · intent.ts · confidence.ts · prompt.ts · parse.ts ·
                      answer.ts (★ orchestration) · readiness.ts
  embeddings/         types.ts · ollama.ts · gemini.ts · registry.ts
  db/                 schema.ts (tables) · client.ts (connection pool) · migrate.ts · migrations/*.sql
  test-support/db.ts  helpers for tests that use a real database
  *.test.ts           tests sit next to the code they test

apps/console/src/
  main.ts             start Vue + the router (4 pages)
  App.vue             the top navigation
  pages/              PlaygroundPage.vue (★) · UsagePage.vue · RequestsPage.vue · RequestDetailPage.vue
  components/         InspectorPanel.vue · AnswerText.vue · AdminKeyInput.vue
  lib/                api.ts (fetch + streaming) · run-state.ts (events → screen state) ·
                      config.ts · session.ts · admin-key.ts

packages/shared/src/
  intents.ts          the 27 intents (+ out_of_scope)
  domain.ts           shared enums and shapes (outcomes, error codes, usage, …)
  api.ts              request/response schemas for every endpoint
  sse.ts              the streaming event contract (10 event types)
  sse-parser.ts       reads an event stream (used by the console, eval and tests)
  normalize.ts        text normalization (must match the Python version)
  dataset.ts          schemas for the data files

scripts/              prepare_data.py · migrate.ts · seed.ts · embed_kb.ts · calibrate.ts ·
                      eval.ts · eval-retrieval.ts · eval-compare.ts · smoke.sh · lib/
data/                 kb/dev/eval splits (JSONL), embedding caches (.f32), thresholds.json
eval/                 results/*.json and report.md
docs/                 the specs (01–12), REPORT.md, screenshots in img/
learn/                this guide
```

★ = the files that matter most. If time is short, read those.

## Conventions you will notice

- **Tests live next to code**: `config/pricing.ts` and `config/pricing.test.ts`, `router/plan.ts` and `router/plan.test.ts`… Some tests cover a whole path across files: `request-path.test.ts` (auth + quota + metering), `routes/chat.test.ts`, `assistant/support.test.ts`.
- **Every file starts with a comment** saying why it exists and which spec section it implements (`docs/03 §5`).
- **Comments explain *why*, not what**. If you wonder why something is done a certain way, read the comment above it first.
- **No `any`**, Zod at every boundary, errors are `AppError(code, status, message)` — see [`CLAUDE.md`](../CLAUDE.md) "Coding conventions".

Next: [03 · Tooling and commands](03-tooling-and-commands.md).

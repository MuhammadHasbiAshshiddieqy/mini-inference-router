# 08 — Deployment

Three ways to run, one codebase:

| Mode | Who | LLM | DB | Command / URL |
|---|---|---|---|---|
| **A. Full Docker** | reviewer with only Docker | Ollama **container** (CPU, small model) + mock | Postgres+pgvector container | `docker compose --profile ollama up --build` |
| **B. Docker + native Ollama (Mac)** | owner (dev, demo recording) | Ollama on host (Metal GPU) + mock | container | `OLLAMA_URL=http://host.docker.internal:11434 OLLAMA_CHAT_MODEL=gemma4:e2b-mlx docker compose up --build` |
| **C. Cloud** | everyone | Gemini 3.5 Flash → Gemini 3 Flash → mock | Neon (Singapore) | Vercel URLs |

Also possible without Docker: `pnpm dev` with a local Postgres and native Ollama.

## 1. Local: `docker-compose.yml`

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment: { POSTGRES_PASSWORD: postgres, POSTGRES_DB: router }
    ports: ["5432:5432"]
    healthcheck: { test: ["CMD", "pg_isready", "-U", "postgres"], interval: 3s, retries: 20 }
    volumes: [pgdata:/var/lib/postgresql/data]

  ollama:
    image: ollama/ollama:latest
    profiles: ["ollama"]
    volumes: [ollama:/root/.ollama]
    healthcheck: { test: ["CMD", "ollama", "list"], interval: 5s, retries: 30 }

  ollama-pull:
    image: ollama/ollama:latest
    profiles: ["ollama"]
    depends_on: { ollama: { condition: service_healthy } }
    environment: { OLLAMA_HOST: "http://ollama:11434" }
    entrypoint: ["sh", "-c", "ollama pull ${OLLAMA_CHAT_MODEL:-gemma4:e2b-it-qat} && ollama pull ${OLLAMA_EMBED_MODEL:-nomic-embed-text}"]
    volumes: [ollama:/root/.ollama]

  migrate:                         # one-shot: migrations + seed + KB load from committed embedding cache
    build: { context: ., dockerfile: apps/gateway/Dockerfile, target: tools }
    depends_on: { postgres: { condition: service_healthy } }
    environment:
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/router
      PROFILE: local
      OLLAMA_URL: ${OLLAMA_URL:-http://ollama:11434}
      OLLAMA_EMBED_MODEL: ${OLLAMA_EMBED_MODEL:-nomic-embed-text}
    command: ["sh", "-c", "pnpm db:migrate && pnpm db:seed && pnpm kb:embed -- --provider ollama --from-cache-only"]

  gateway:
    build: { context: ., dockerfile: apps/gateway/Dockerfile, target: runtime }
    depends_on:
      postgres: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    environment:
      PROFILE: local
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/router
      ADMIN_API_KEY: ${ADMIN_API_KEY:-local-admin}
      CORS_ORIGINS: http://localhost:5173
      OLLAMA_URL: ${OLLAMA_URL:-http://ollama:11434}
      OLLAMA_CHAT_MODEL: ${OLLAMA_CHAT_MODEL:-gemma4:e2b-it-qat}
      OLLAMA_THINK: "false"
      OLLAMA_EMBED_MODEL: ${OLLAMA_EMBED_MODEL:-nomic-embed-text}
      OLLAMA_TTFT_TIMEOUT_MS: ${OLLAMA_TTFT_TIMEOUT_MS:-60000}
      OLLAMA_TOTAL_TIMEOUT_MS: ${OLLAMA_TOTAL_TIMEOUT_MS:-180000}
    extra_hosts: ["host.docker.internal:host-gateway"]   # mode B on Linux too
    ports: ["8787:8787"]

  console:
    build: { context: ., dockerfile: apps/console/Dockerfile, args: { VITE_GATEWAY_URL: "http://localhost:8787" } }
    ports: ["5173:80"]

volumes: { pgdata: {}, ollama: {} }
```

Notes:
- **Docker on macOS has no Metal GPU access**, so the Ollama container runs on CPU. That is why the container uses the GGUF `gemma4:e2b-it-qat` (MLX tags cannot run in a Linux container) and a long TTFT timeout. Mode B (native `gemma4:e2b-mlx`) is for real use on the Mac.
- **Docker Desktop must have ≥ 8 GB memory** (Settings → Resources); otherwise the model is OOM-killed. State this in the README.
- Mode B in Docker: when the gateway runs inside Docker it reaches the host Ollama via `host.docker.internal`. Native Ollama listens on 127.0.0.1 by default, which Docker Desktop on macOS forwards correctly. On Linux hosts, set `OLLAMA_HOST=0.0.0.0` for the Ollama service.
- The gateway does **not** wait for model pulls. Until Ollama is ready, requests fall back to mock, and the attempt rows show why. `/healthz` reports `ollama: {reachable, models_present}`.
- `kb:embed --from-cache-only` loads `data/embeddings/nomic-embed-text.f32` without calling Ollama (fast on CPU). If the cache is missing it fails with a clear message.
- The demo keys for local mode come from `.env` (`SEED_KEY_*`). If they are empty, seed generates keys and prints them once. The console in Docker gets `VITE_DEMO_TENANTS` at build time from `.env`.
- `docker-compose.gpu.yml` (optional): adds `deploy.resources.reservations.devices: [{driver: nvidia, count: all, capabilities: [gpu]}]` to `ollama`. Documented, not tested.

### Dockerfiles

- `apps/gateway/Dockerfile`: multi-stage on `node:22-alpine` with corepack pnpm. Stage `deps` → `build` (tsc/tsup) → `tools` (full workspace for scripts) → `runtime` (prod deps + dist, non-root user, `CMD ["node","dist/local.js"]`, `HEALTHCHECK` on `/healthz`).
- `apps/console/Dockerfile`: build with Vite (`ARG VITE_GATEWAY_URL`, `ARG VITE_DEMO_TENANTS`) → serve `dist/` with `nginx:alpine` and an SPA fallback (`try_files $uri /index.html`).

## 2. Cloud: Neon + Vercel

### Neon (already created: project in AWS Asia Pacific 1, Singapore)

1. Services: **Postgres only**. Do not enable Object storage, Functions, AI gateway or Neon Auth.
2. Copy the **pooled** connection string (host contains `-pooler`, `sslmode=require`) → `DATABASE_URL`.
3. From the laptop: `DATABASE_URL=<neon> pnpm db:migrate` (the migration runs `CREATE EXTENSION IF NOT EXISTS vector` and `pg_trgm`; both are supported on Neon, but verify).
4. `DATABASE_URL=<neon> PROFILE=cloud GEMINI_API_KEY=... pnpm db:seed && pnpm kb:embed -- --provider gemini`. This uses or creates `data/embeddings/<gemini-model>.f32`; commit the cache.
5. `PROFILE=cloud pnpm calibrate` → commit `data/thresholds.json`.

The free plan scales to zero after inactivity and wakes on the next connection (≈ sub-second to a few seconds). Tell reviewers the first request may be slower.

### Vercel: two projects from the same GitHub repo

**Gateway project**
- Root Directory: `apps/gateway`. Framework preset: **Hono** (zero-config; the entry is `src/index.ts` with `export default app`).
  Do **not** name the local runner `server.ts`/`app.ts` at the root of `src`, because Vercel scans those names. Use `src/local.ts` for `@hono/node-server`.
- Keep "Include source files outside of the Root Directory" enabled (workspace package `packages/shared`).
- `apps/gateway/vercel.json`: `{ "regions": ["sin1"], "functions": { "src/index.ts": { "maxDuration": 120 } } }`, the same region as Neon. `maxDuration` 120 s covers the worst case (escalation + fallback ≈ 2 × 30 s total timeout + TTFT timeouts). Hobby: one region, 300 s default and maximum with Fluid compute (source: https://vercel.com/docs/functions/configuring-functions/duration and …/region, checked 2026-10-06). Confirm on the first deploy that the `functions` key matches the zero-config Hono entry; otherwise set the default max duration in Project Settings → Functions.
- Env vars: `PROFILE=cloud`, `DATABASE_URL` (Neon pooled), `ADMIN_API_KEY`, `CORS_ORIGINS=https://<console>.vercel.app`, `GEMINI_*`, `MOCK_*`, `CONFIDENCE_*` (optional; otherwise thresholds.json).
- Streaming: Vercel Functions support streaming responses. Use Hono's `streamSSE`. Verify the SSE flushes incrementally on the deployed URL (curl `-N`).
- **Deployment Protection**: Settings → Deployment Protection. Production must be publicly reachable. Share only the production domains (preview URLs may require Vercel login).
- SSE headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`. Do not apply compression middleware to SSE routes.
- Lifecycle: finish metering writes **before** emitting `done`. On client abort, schedule the final metering write with `waitUntil` (from `@vercel/functions`; verify the API) so it is not frozen.
- Gemini key on Vercel = the **`router-demo`** project key. Never use the eval project key in production.
- Runtime logs are kept only 1 hour on Hobby. The DB tables are the evidence.
- In-memory state is per instance and short-lived. Nothing correctness-critical relies on it (debug overrides are per-request; quota is in the DB).
- Database pool: `pg.Pool({ max: 3 })`, created lazily and reused across invocations.

**Console project**
- Root Directory: `apps/console`. Framework preset: Vite. Output: `dist`.
- Env (build-time): `VITE_GATEWAY_URL=https://<gateway>.vercel.app`, `VITE_DEMO_TENANTS=[...]` (demo keys of `acme`, `globex`, `tiny`).
- SPA rewrite: `apps/console/vercel.json` → `{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }`.

### Deploy runbook (prepared in Phase 9; needs the owner's Neon and Vercel access)

1. Neon (pooled URL in `DATABASE_URL`): `pnpm db:migrate`, then `PROFILE=cloud pnpm db:seed` with `SEED_KEY_*` set (pin the keys), then `pnpm kb:embed -- --provider gemini --from-cache-only` (loads the committed `data/embeddings/gemini-embedding-001.f32`, **no Gemini calls**). Thresholds come from the committed `data/thresholds.json`.
2. Vercel gateway project: Root Directory `apps/gateway`, framework Hono, "Include source files outside of the Root Directory" on (it imports `packages/shared` and `data/thresholds.json`). Env: `PROFILE=cloud`, `DATABASE_URL`, `ADMIN_API_KEY`, `CORS_ORIGINS=https://<console>.vercel.app`, `GEMINI_API_KEY` (**router-demo** project). `apps/gateway/vercel.json` sets `regions: ["sin1"]` and `maxDuration: 120` for `src/index.ts`.
3. Vercel console project: Root Directory `apps/console`, framework Vite, build `pnpm build`, output `dist`; env `VITE_GATEWAY_URL`, `VITE_DEMO_TENANTS` (acme, globex, tiny keys only). `apps/console/vercel.json` rewrites every path to `index.html`.
4. Deployment Protection off for production; then `BASE=https://<gateway> … EXPECT_PROFILE=cloud ./scripts/smoke.sh` and `curl -N` to confirm incremental streaming.

Open items to confirm on the first deploy: zero-config Hono builds the `.ts`-extension imports and the JSON import of `data/thresholds.json`; the `functions` key matches the detected entry; `@vercel/functions` (`waitUntil`, `attachDatabasePool`) awaits owner approval (docs/11 rule).

## 3. Smoke test (`scripts/smoke.sh`)

Runs against any base URL and any profile (the primary and fallback backends are read from `/healthz`; set `EXPECT_PROFILE=cloud` for prod). Prints PASS/FAIL per check and exits non-zero on any failure. Used after every deploy and shown in the video. Verified 13/13 PASS against the local profile (Ollama → mock) on 2026-10-06.

```
BASE=https://<gateway>.vercel.app KEY=<acme> TINY=<tiny> GLOBEX=<globex> ADMIN=<admin> ./scripts/smoke.sh
```

Checks:
1. `GET /healthz` → 200 and profile=cloud.
2. No key → 401 `missing_api_key`. Bad key → 401 `invalid_api_key`.
3. Bad body → 400 `invalid_request`.
4. Support stream (`curl -N`) → events `meta, retrieval, route, intent, token…, done`, outcome `ok`.
5. Force-fail the primary (`debug.force_fail:["gemini-3.5-flash"]`) → `attempt_failed` then `done.fallback_fired=true`, served by `gemini-3-flash`.
6. Force-fail both Gemini models → served by `mock`.
7. Tenant policy: a `globex` request is served by `gemini-3-flash`, and its attempts never include `gemini-3.5-flash`.
   A `globex` request with `debug` → 403 `debug_not_allowed`.
8. OOS message → `refusal`. `debug.force_embedding_fail:true` → `retrieval.mode = lexical_fallback`, answer still streams, confidence ≤ medium.
9. Exhaust `tiny` (loop) → 429 `quota_exceeded` with remaining 0.
10. `GET /admin/requests/<id from step 5>` → 2 attempts with reasons `primary` and `fallback:forced_failure`.

## 4. Pre-submission checks

- Open both URLs in a private window from a different network (mobile hotspot).
- `pnpm db:seed --reset-usage` against Neon right before submitting, so quotas are fresh for reviewers. The `reviewer` key goes only in the email.
- Check that the Gemini demo project's RPD has not been consumed by recording (RPD resets 14:00 WIB).
- Confirm the Gemini key's free-tier limits in AI Studio. Consider a second Gemini project key for eval runs, so the eval does not exhaust the demo's quota.

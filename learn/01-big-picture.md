# 01 · The big picture (≈ 30 min)

## What the system does, in two sentences

Product teams should not call AI providers directly; they call **one gateway**, which picks a model, enforces
what each customer ("tenant") may do and spend, and records what every request cost. On top of that gateway we
built one feature: a **customer-support assistant** that answers a question from a knowledge base and says which
*intent* (e.g. `cancel_order`, `track_refund`) the question has.

This is a take-home assessment; the original brief is quoted in [`docs/01-requirements.md`](../docs/01-requirements.md).

## How many services are there?

**Three things you run, plus three kinds of model backend.**

| # | Service | What it is | Code | Runs on |
|---|---|---|---|---|
| 1 | **Gateway** | The HTTP API: auth, quota, routing, streaming, metering, the support assistant | `apps/gateway` | Node.js (locally, in Docker, or on Vercel) |
| 2 | **Console** | A web page to try the gateway and inspect what happened | `apps/console` | Your browser (built by Vite, served by nginx or Vercel) |
| 3 | **Database** | PostgreSQL with the **pgvector** extension: tenants, metering, the knowledge base with its vectors | migrations in `apps/gateway/src/db` | Docker locally, Neon in the cloud |
| – | **Model backends** | Where answers come from. The gateway talks to them; they are not our code | adapters in `apps/gateway/src/backends` | see below |

The model backends:

| Backend | What | Where |
|---|---|---|
| **Gemini** (`gemini-3.5-flash`, `gemini-3-flash`) | Google's hosted models, called over HTTPS with an API key | Google's servers |
| **Ollama** (`gemma4`) | A program that runs open models on your own machine | your Mac, or a Docker container |
| **Mock** | A fake model inside the gateway that answers with a fixed text or the best knowledge-base answer | in the gateway process |

Two more folders are **not services**:

- `packages/shared` is a **library** both apps import (types and validation rules), never run on its own.
- `scripts/` holds **command-line tools** you run by hand: prepare the data, seed the database, embed the knowledge base, calibrate thresholds, evaluate quality, smoke-test a deployment.

```
            ┌──────────────┐        HTTPS + API key, streamed events (SSE)
 browser ─► │  Console     │ ─────────────────────────────┐
            └──────────────┘                              ▼
 curl / eval script ─────────────────────────────► ┌──────────────┐ ──► Gemini (Google)
                                                   │   Gateway    │ ──► Ollama (local)
                                                   │  (Node.js)   │ ──► Mock (inside)
                                                   └──────┬───────┘
                                                          ▼
                                              ┌───────────────────────┐
                                              │ Postgres + pgvector   │
                                              │ tenants · requests ·  │
                                              │ route_attempts ·      │
                                              │ kb_entries (+vectors) │
                                              └───────────────────────┘
```

## Two endpoints do the real work

| Endpoint | Input | Output |
|---|---|---|
| `POST /v1/chat` | a list of chat messages | a streamed answer from whichever model served it |
| `POST /v1/support/answer` | one customer message | a streamed answer **plus** the detected intent, the knowledge-base entries used, and a confidence level — or a polite refusal |

The other endpoints only read data: `GET /v1/usage` (your own quota), `GET /admin/usage`, `GET /admin/requests`,
`GET /admin/requests/:id` (what happened to one request), and `GET /healthz` (is it alive, how is it configured).

## Profiles: same code, different models

The environment variable `PROFILE` chooses which backends exist, in priority order
([`config/profiles.ts`](../apps/gateway/src/config/profiles.ts)):

| Profile | Backends tried in order | Knowledge-base embeddings |
|---|---|---|
| `cloud` (deployed) | Gemini 3.5 Flash → Gemini 3 Flash → Mock | Gemini `gemini-embedding-001` |
| `local` | Ollama → Mock | Ollama `nomic-embed-text` |
| `hybrid` | Gemini 3.5 Flash → Ollama → Mock | Gemini |

## One support request, end to end

Follow this once now; you will read each step's code in the gateway chapters.

1. **The browser sends** `POST /v1/support/answer` with `Authorization: Bearer <key>` and `{"message": "I want to cancel my order"}`.
2. **Request id.** The gateway gives the request a unique, time-ordered id and adds it to every log line → `http/request-id.ts`.
3. **Size and type checks.** Too big → 413, not JSON → 415 → `http/body.ts`.
4. **Who are you?** The key is hashed and looked up in `tenants` → 401/403 if wrong, 503 if the database is down → `http/auth.ts`.
5. **Is the request valid and allowed?** Zod checks the body; tenant rules (max output, debug options) and the routing plan are checked → 400/403/422 → `http/admission.ts`, `router/plan.ts`.
6. **Can you afford it?** Tokens are **reserved** in one atomic SQL update; not enough → 429 → `quota/quota.ts`. A `requests` row is written with outcome `in_progress`.
7. **The stream opens.** From here the answer is a series of events (`meta`, `retrieval`, `route`, `intent`, `token` …, `done`) → `http/sse.ts`.
8. **Find similar questions.** The message is turned into a vector (an *embedding*) and the 5 closest knowledge-base entries are fetched with pgvector → `assistant/retrieve.ts`.
9. **Is it even a support question?** If the best match is too far away, refuse now, without calling any model (0 tokens) → `assistant/confidence.ts`.
10. **Call a model, with fallback.** Try the backends in order; if one fails or is too slow *before* any text was shown, try the next → `router/execute.ts`, `backends/*.ts`.
11. **Check the model's answer.** It must start with `INTENT: <label>` then `---`. Nothing is shown until that header is valid. If the model's intent disagrees with the knowledge base, or the header is garbage, retry once more carefully (*escalation*) or refuse → `assistant/parse.ts`, `assistant/answer.ts`.
12. **Stream the answer** token by token to the browser.
13. **Settle the bill.** Replace the reservation with the real token count, compute the cost, finalize the `requests` row and one `route_attempts` row per backend tried — then send `done` → `http/admission.ts` (`settle`), `metering/*.ts`.

`/v1/chat` is the same path without steps 8, 9 and 11.

## Where it runs

| Mode | How | Guide |
|---|---|---|
| Your laptop, no Docker for the apps | `pnpm dev` + Postgres in Docker + native Ollama | [03-tooling-and-commands.md](03-tooling-and-commands.md) |
| Everything in Docker | `docker compose --profile ollama up --build` | [`docs/08-deployment.md`](../docs/08-deployment.md) |
| Cloud | Vercel (gateway + console) + Neon (Postgres) | [`docs/08-deployment.md`](../docs/08-deployment.md) |

Next: [02 · Repository tour](02-repo-tour.md).

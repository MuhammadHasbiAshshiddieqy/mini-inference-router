# 04 · The gateway, step by step (≈ 2.5 hours)

The gateway (`apps/gateway`) is the heart of the project: about 3,000 lines of TypeScript plus tests. These
chapters follow a request in the order it travels, so each chapter builds on the previous one.

| Chapter | Time | Files you read alongside |
|---|---|---|
| [01 · Entry points and plumbing](01-entry-and-plumbing.md) | 25 min | `index.ts`, `local.ts`, `create-app.ts`, `config/env.ts`, `logger.ts`, `http/request-id.ts`, `http/errors.ts`, `http/error-handler.ts`, `routes/health.ts` |
| [02 · Auth, quota and metering](02-auth-quota-metering.md) | 30 min | `http/body.ts`, `http/auth.ts`, `http/admission.ts`, `quota/quota.ts`, `metering/*`, `config/pricing.ts`, `routes/usage.ts`, `routes/admin.ts` |
| [03 · Backends and the router](03-backends-and-router.md) | 35 min | `backends/*`, `config/profiles.ts`, `router/plan.ts`, `router/execute.ts` |
| [04 · Streaming and `/v1/chat`](04-streaming-and-chat.md) | 20 min | `http/sse.ts`, `routes/chat.ts` |
| [05 · The support assistant](05-support-assistant.md) | 40 min | `assistant/*`, `embeddings/*`, `routes/support.ts`, `config/thresholds.ts` |
| [06 · The database](06-database.md) | 15 min | `db/*`, `migrations/*.sql`, `test-support/db.ts` |

## Three patterns used everywhere

Learn these once; they explain most of the code.

**1. Dependencies are passed in, not imported as globals.** `createApp({ env, logger, getPool, registry, … })`
receives everything it needs. Production code passes the real database and real backends; tests pass a test
database, fake backends and a silent logger. That is why almost every module exports a `createX(...)` function
or a function that takes a `db`/`pool` argument. *Why:* code that can be tested without a network can be tested
deterministically (no flaky tests, no spent quota).

**2. Pure decision functions, thin I/O around them.** Decisions are plain functions with no network or
database: `plan()` (which backends), `decideOnHeader()` (answer/refuse/escalate), `costUsd()`,
`retrievalSignals()`, the output parser. The code that talks to the outside world (`execute()`, `retrieve()`,
`runSupport()`) calls them. *Why:* the reviewers judge the decisions, and pure functions are easy to read and to
test row by row.

**3. Errors have a code and a status.** Anything the client should see is thrown as
`new AppError("quota_exceeded", 429, "Token quota exceeded", details)`. One error handler turns it into
`{ "error": { "code", "message", "request_id", "details" } }`. Anything else becomes a generic 500 and the real
error is only logged. *Why:* stable error codes for clients, no leaked internals.

## A request's path through the files

```
create-app.ts
 ├─ request-id.ts ─ cors ─ error-handler.ts
 ├─ /healthz ─────────────────────────────── routes/health.ts
 ├─ /v1/*:  body.ts (413/415) → auth.ts (tenant)
 │    ├─ GET  /v1/usage ─────────────────── routes/usage.ts → metering/usage.ts
 │    ├─ POST /v1/chat ──────────────────── routes/chat.ts
 │    │      admit() ─ plan() ─ openEventStream() ─ execute() ─ settle()
 │    └─ POST /v1/support/answer ────────── routes/support.ts
 │           admit() ─ plan() ─ openEventStream() ─ runSupport():
 │                retrieve() → preGate() → execute() + parser → decideOnHeader() → settle()
 └─ /admin/*: auth.ts (admin key) → routes/admin.ts → metering/usage.ts
```

Start with [01 · Entry points and plumbing](01-entry-and-plumbing.md).

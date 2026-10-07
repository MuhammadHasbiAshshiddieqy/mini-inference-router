# Gateway 01 · Entry points and plumbing (≈ 25 min)

Files: `apps/gateway/src/` → `index.ts`, `local.ts`, `create-app.ts`, `config/env.ts`, `logger.ts`,
`http/request-id.ts`, `http/types.ts`, `http/errors.ts`, `http/error-handler.ts`, `routes/health.ts`.

## Why there are two entry files

The same app runs in two very different places:

- **On your laptop or in Docker** a long-running Node process listens on port 8787.
- **On Vercel** there is no long-running process: Vercel imports a file, takes its *default export*, and calls it for each request ("serverless").

So the app is **built** in one place and **started** in two:

```
index.ts      ── builds env + logger + database getter, calls createApp(), `export default app`  ← Vercel uses this
local.ts      ── imports index.ts and starts an HTTP server with @hono/node-server               ← pnpm dev / Docker
create-app.ts ── the function that assembles the app (no side effects; tests call it directly)
```

Read [`index.ts`](../../apps/gateway/src/index.ts) (17 lines) and [`local.ts`](../../apps/gateway/src/local.ts) (13 lines) now.
Notice that the database is *lazy*: `lazyDb(...)` returns a function, and the connection pool is created the first
time a request needs it. `local.ts` also starts a background Ollama warm-up so the first question is not slow.

> `create-app.ts` is deliberately **not** called `app.ts` or `server.ts`: Vercel treats files with those names as
> entry points.

## Hono in five lines

[Hono](https://hono.dev) is the web framework. It is small: you create an app, add **middleware** (functions that
run for many routes, in order) and **routes** (functions for one path).

```ts
const app = new Hono<AppEnv>();
app.use(requestContext(logger));                    // runs for every request, first
app.use("/v1/*", limitBody, requireJson, tenantAuth(getPool));   // runs for every /v1/... request
app.route("/v1", chatRoutes({ … }));                // mounts POST /v1/chat
app.onError(errorHandler);                          // what to do when anything throws
```

A middleware receives `(c, next)`. `c` is the **context** (request, response helpers, and a small key-value
store). Calling `await next()` runs the rest of the chain; code after it runs on the way back out.
`c.set("tenant", …)` stores a value for later handlers; `c.get("tenant")` reads it. The names and types of those
values are declared once in [`http/types.ts`](../../apps/gateway/src/http/types.ts) (`AppEnv`).

## `create-app.ts`: the order matters

Open [`create-app.ts`](../../apps/gateway/src/create-app.ts). The comment above `createApp` lists the order,
and the code follows it exactly:

1. `requestContext` — give the request an id; attach a logger that prints that id on every line.
2. `cors` — answer the browser's "may I call you?" pre-flight request (the console runs on another port/domain).
3. `onError` / `notFound` — turn every thrown error into a JSON error.
4. `/healthz` — no key needed.
5. `/v1/*` — size and content-type checks, then **tenant authentication**, then the routes.
6. `/admin/*` — admin authentication, then the admin routes.

Everything the routes need (env, the database getter, the backend registry, the query embedder, the refusal
thresholds) is passed in as arguments with defaults. Tests replace any of them.

## Configuration: `config/env.ts`

Read the top of [`config/env.ts`](../../apps/gateway/src/config/env.ts). It is one big Zod object: each line
names a variable, its type, and its default.

```ts
PORT: positiveInt.default(8787),
DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
GEMINI_THINKING_LEVEL: z.enum(["minimal", "low", "medium", "high"]).default("minimal"),
```

`loadEnv()` treats empty values as unset, runs the schema, adds one cross-field rule (a Gemini profile needs a
Gemini key), and if anything is wrong throws **one** error listing every problem. Try it: start the gateway with
`PROFILE=cloud` and no key, and read the message.

Comments with `source: <url>, checked <date>` mark values that came from external documentation (model ids,
prices). That is a project rule: never hard-code an external fact without saying where it came from.

## Request id and logging

[`http/request-id.ts`](../../apps/gateway/src/http/request-id.ts) generates a **UUIDv7**: a unique id whose first
part is the current time, so ids sort by creation time (handy in the database and in logs). The id is
returned in the `x-request-id` response header and becomes the primary key of the `requests` row.

[`logger.ts`](../../apps/gateway/src/logger.ts) creates a [pino](https://getpino.io) logger. `logger.child({ request_id })`
returns a logger that adds that field to every line. Some fields are redacted (`authorization`, `apiKey`) as a
safety net; the real rule is to never log keys or message bodies in the first place.

## Errors

[`http/errors.ts`](../../apps/gateway/src/http/errors.ts) defines `AppError(code, httpStatus, message, details?)`.
The list of allowed codes lives in `packages/shared/src/domain.ts` (`ERROR_CODES`), so the console knows them too.

[`http/error-handler.ts`](../../apps/gateway/src/http/error-handler.ts) is the *only* place that turns errors
into responses:

```ts
if (err instanceof AppError) return c.json(errorBody(c, err), err.httpStatus);   // expected: show it
log.error({ err }, "unhandled error");                                           // unexpected: log it…
return c.json(errorBody(c, new AppError("internal_error", 500, "Internal server error")), 500);  // …hide it
```

A test proves the second branch never leaks the real message (`create-app.test.ts`, "db password is hunter2").

## `/healthz`

[`routes/health.ts`](../../apps/gateway/src/routes/health.ts) answers without a key. It reports the
configuration (profile, backends in priority order, embedding model, prompt version, thresholds — never
secrets), whether Ollama is reachable (a cheap `GET /api/tags`, never a model call), and whether the support
assistant is ready (knowledge-base rows, `pg_trgm`, thresholds). If the assistant is not ready it answers
**503 `degraded`** with the command that fixes each problem. The eval script stores this response next to its
results so every number can be traced to a configuration.

## Try it

```bash
pnpm --filter gateway dev
curl -i localhost:8787/healthz          # note the x-request-id header
curl -i -X POST localhost:8787/nope     # the JSON 404, with the same request id in body and header
```

Next: [02 · Auth, quota and metering](02-auth-quota-metering.md).

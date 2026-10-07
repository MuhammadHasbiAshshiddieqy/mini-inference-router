# 00 · JavaScript and TypeScript crash course (≈ 60 min)

You do not need to master JavaScript to read this repo. You need to recognise about twenty patterns. Each one
below has a short explanation and a real example from the code, so you can find it again.

**JavaScript (JS)** is the language that runs in browsers and in **Node.js** (JS on a server).
**TypeScript (TS)** is JavaScript plus *types*: labels that say what kind of value a variable holds. The types are
checked by a tool (`tsc`) and then simply removed before the code runs. Every `.ts` file in this repo is
TypeScript; the `.vue` files contain TypeScript inside `<script setup lang="ts">`.

---

## 1. Variables: `const` and `let`

```ts
const port = 8787;      // cannot be reassigned (used almost everywhere)
let attempt = 1;        // can be reassigned
attempt = attempt + 1;
```

Rule of thumb in this repo: `const` unless the value really changes. You will almost never see `var`.

## 2. Functions and arrow functions

```ts
function estimateTokens(text: string): number {      // classic function
  return Math.ceil(text.length / 4);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));   // arrow function
```

- `text: string` is a **parameter type**, `: number` after the parentheses is the **return type**.
- An arrow function `(x) => expression` returns the expression directly. With braces `(x) => { … }` you need `return`.
- Real example: [`apps/gateway/src/quota/quota.ts`](../apps/gateway/src/quota/quota.ts) (`estimateTokens`).

## 3. Objects, arrays, destructuring and spread

```ts
const tenant = { id: "acme", quotaTokens: 150_000 };   // object (underscores in numbers are just for reading)
const ids = ["gemini-3.5-flash", "mock"];              // array

const { id, quotaTokens } = tenant;                    // destructuring: pull fields out by name
const copy = { ...tenant, quotaTokens: 0 };            // spread: copy all fields, then override one
const all = [...ids, "ollama"];                        // spread for arrays

function createApp({ env, logger, getPool }: AppDeps) { … }   // destructuring in a parameter
```

Destructuring in parameters is used everywhere; see [`create-app.ts`](../apps/gateway/src/create-app.ts).

## 4. Template strings

```ts
const msg = `Tenant ${tenant.id} has ${quotaTokens} tokens`;   // backticks + ${…}
```

## 5. Modules: `import` and `export`

Each file is a module. It exports what others may use and imports what it needs.

```ts
export function createApp(…) { … }          // named export
export default app;                          // default export (one per file)

import { createApp } from "./create-app.ts"; // import a named export
import app, { env } from "./index.ts";       // default + named
import type { Logger } from "pino";          // import only a TYPE (erased at runtime)
```

Two things that surprise newcomers here:

- **Imports end in `.ts`.** Node runs our TypeScript files directly (see [11-faq.md](11-faq.md)), so imports point at the real file name.
- `"./x.ts"` is a file in this project; `"pino"` (no dot) is a package from `node_modules`; `"@mir/shared"` is our own workspace package ([02-repo-tour.md](02-repo-tour.md)).

## 6. Optional chaining `?.` and nullish coalescing `??`

```ts
const status = result.servedBy?.backendId;   // undefined instead of a crash if servedBy is null/undefined
const max = body.max_output_tokens ?? 512;   // use 512 only if the left side is null or undefined
handle ??= createDb(options);                // assign only if handle is still null/undefined
```

`??=` is how [`db/client.ts`](../apps/gateway/src/db/client.ts) creates the database pool only once (`lazyDb`).

## 7. `async` / `await` and Promises

Anything that waits (database, HTTP, a model) returns a **Promise**: a value that arrives later.
`await` pauses the function until it arrives. A function that uses `await` must be marked `async`.

```ts
async function loadUsage() {
  const res = await fetch(url);        // wait for the HTTP response
  return await res.json();             // wait for the body
}

const [tenants, totals] = await Promise.all([queryA(), queryB()]);   // run two in parallel, wait for both
```

Errors in async code are caught with `try { … } catch (err) { … } finally { … }`.
`finally` always runs — the quota is reconciled in that spirit even when something fails.

## 8. Types: the basics you will see

```ts
type Tenant = { id: string; quotaTokens: number; allowDebug: boolean };   // a "shape"
type Outcome = "ok" | "refused" | "partial_error";                         // union of literal strings
let ttft: number | null = null;                                            // "a number or null"
const scores: Record<string, number> = {};                                 // object used as a dictionary
function first<T>(xs: T[]): T | undefined { return xs[0]; }                // generic: works for any type T
```

- `interface Backend { … }` is very similar to `type Backend = { … }`.
- `unknown` means "we don't know yet; check before use". This repo forbids `any` (which turns checking off).
- `x!` (non-null assertion) tells TS "trust me, this is not null". Used sparingly.
- `as const` freezes a literal list so its values become a type: see `INTENTS` in [`packages/shared/src/intents.ts`](../packages/shared/src/intents.ts).

## 9. Discriminated unions and `switch`

A union whose members share a field (often `type`) that tells them apart. TS then knows which fields exist.

```ts
type StreamChunk =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; arguments: unknown }
  | { type: "usage"; promptTokens: number; completionTokens: number; … };

if (chunk.type === "usage") { usage = chunk; }       // here TS knows chunk has promptTokens
```

From [`backends/types.ts`](../apps/gateway/src/backends/types.ts). The router uses this to treat text, tool calls
and usage differently.

## 10. Factory functions instead of classes

Most components are created by a function that returns an object, for example:

```ts
export function createMockBackend(spec: BackendSpec, options: MockOptions): Backend {
  return {
    spec,
    async *stream(req) { … },
  };
}
```

The returned object "remembers" the arguments (`spec`, `options`) — that is called a **closure**. You will see
`createApp`, `createDb`, `createGeminiBackend`, `createOllamaEmbedder`, … all built this way. Classes are used
only for errors (`class AppError extends Error`) and the output parser.

## 11. Async generators: how streaming works

A **generator** (`function*`) produces values one by one with `yield`. An **async generator**
(`async function*`) can `await` between yields. The consumer reads it with `for await … of`.

```ts
async *stream(req) {                       // in a backend adapter
  for await (const chunk of providerStream) {
    yield { type: "text", text: chunk.text };   // hand one piece to the router, then continue
  }
}

for await (const chunk of backend.stream(req)) { … }   // in the router (simplified)
```

This is exactly how model tokens flow from Gemini/Ollama to the browser. See [`backends/mock.ts`](../apps/gateway/src/backends/mock.ts)
— the easiest one to read.

## 12. Cancelling work: `AbortController` and `AbortSignal`

```ts
const controller = new AbortController();
setTimeout(() => controller.abort("timeout_ttft"), 8000);   // cancel after 8 s
await fetch(url, { signal: controller.signal });             // fetch stops when aborted
```

The router gives every backend attempt its own controller with two timers (time-to-first-token and total) and
links it to the client's connection, so a closed browser tab stops the model. See
[`router/execute.ts`](../apps/gateway/src/router/execute.ts).

## 13. Zod: checking data at the edges

TypeScript types disappear at runtime, so data coming from outside (HTTP bodies, env vars, files, model
output) is checked with **Zod**. You write a schema once and get both a runtime check and a TS type:

```ts
import { z } from "zod";
const SupportRequestSchema = z.strictObject({
  message: z.string().trim().min(1).max(2000),
  stream: z.boolean().optional(),
});
type SupportRequest = z.infer<typeof SupportRequestSchema>;   // { message: string; stream?: boolean }

const parsed = SupportRequestSchema.safeParse(json);          // never throws
if (!parsed.success) { /* parsed.error.issues lists what is wrong → HTTP 400 */ }
```

Real schemas live in [`packages/shared/src/api.ts`](../packages/shared/src/api.ts) and
[`apps/gateway/src/config/env.ts`](../apps/gateway/src/config/env.ts).

## 14. Small things you will meet

| Code | Meaning |
|---|---|
| `new Map()`, `new Set()` | dictionary with any key type; list of unique values |
| `arr.map(f)`, `arr.filter(f)`, `arr.reduce(f, 0)` | transform, keep some, combine into one value |
| `Object.fromEntries([["a", 1]])` | turn pairs into an object `{ a: 1 }` |
| `123n`, `BigInt(x)` | big integers; used for exact money maths in [`config/pricing.ts`](../apps/gateway/src/config/pricing.ts) |
| `performance.now()` | precise clock in milliseconds, for latency |
| `void promise` | start an async task on purpose without waiting for it |
| `/^\d+$/.test(s)` | regular expression test |
| `process.env.X` | read an environment variable (only via `config/env.ts` in the gateway) |

## 15. Vue in one paragraph (for the console)

A `.vue` file has a `<script setup lang="ts">` block (logic) and a `<template>` block (HTML).
`ref(0)` creates a reactive value; when it changes, the parts of the template that use it re-render.
`{{ value }}` prints a value, `v-if` shows an element conditionally, `v-for` repeats it, `@click="fn"` handles an
event, `:prop="expr"` binds an attribute to an expression. That is enough for [06-console.md](06-console.md).

---

**Check yourself:** open [`apps/gateway/src/backends/mock.ts`](../apps/gateway/src/backends/mock.ts) (65 lines).
You should recognise: imports, a type, a factory function, an `async *stream` generator, `await`, `yield`, an
`AbortSignal`. If you do, move on to [01 · The big picture](01-big-picture.md).

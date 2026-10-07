# 11 · FAQ: "why is it like this?"

### Why are there several `node_modules` folders?

Each package (`apps/gateway`, `apps/console`, `packages/shared`, `scripts`) declares its own dependencies, and
Node looks for imports in the nearest `node_modules`. pnpm gives each package a small `node_modules` full of
**links** to a single shared store in the root `node_modules/.pnpm/`. Disk usage stays low (277 MB in the root,
a few KB per package), and a package cannot accidentally use a dependency it did not declare.
Details: [02-repo-tour.md](02-repo-tour.md#why-are-there-several-node_modules-folders).

### Why do imports end in `.ts`?

Node runs the TypeScript files directly, and Node needs the real file name. TypeScript is configured to allow
it (`allowImportingTsExtensions`). The console is bundled by Vite, which accepts both.

### Why is there no build step for the gateway?

Since Node 22.18, Node strips type annotations when it loads a `.ts` file. So `node src/local.ts` just works, in
dev, in Docker and in scripts — one less tool and one less place for differences between dev and production.
The price: a few TypeScript features that cannot simply be erased (`enum`, constructor parameter properties) are
not allowed (`erasableSyntaxOnly`), and the imports use `.ts`.

### Why TypeScript at all, if it is erased?

Because `pnpm -r typecheck` catches mistakes before running anything: a misspelt field, a missing case, a `null`
not handled. The reviewers also read the types as documentation (`Backend`, `StreamChunk`, `Decision`).

### Why Zod when there are TypeScript types?

Types only exist while checking; at runtime they are gone. Data from outside (HTTP bodies, env vars, files, model
output, events received by the console) can be anything, so it is checked at runtime by Zod. One schema gives both
the check and the type.

### Why not LangChain / an AI framework?

The assessment is about the routing, fallback, quota, streaming and metering layer. Those frameworks *are* that
layer; using them would hide exactly what is being judged and lose details we must measure (per-attempt records,
TTFT vs total timeouts, thinking tokens). See [`docs/11-tech-decisions.md`](../docs/11-tech-decisions.md).

### Why raw SQL when Drizzle is installed?

Drizzle defines the schema and runs migrations. The critical queries (the atomic quota update, the hybrid search)
are clearer and more precise as SQL, which reviewers can read directly. Values are always passed as parameters
(`$1`), never pasted into the SQL text.

### Why are money values strings and BigInts?

Floating-point numbers cannot store most decimals exactly (`0.1 + 0.2 = 0.30000000000000004`). Costs are
computed with integers in units of 1e-8 USD and stored as `numeric(12,8)`.

### Why does the gateway sometimes answer from "mock"?

When every real model fails, times out or runs out of free quota, the mock answers with the best
knowledge-base answer and the kNN intent, so the user still gets something grounded, clearly labelled MOCK. On
the Gemini free tier this happens after ~20 requests per model per day (see `docs/12-free-tier-limits-and-risks.md`).

### Why does the assistant refuse some reasonable questions?

The first check compares the question with the knowledge base. Very misspelt or rude phrasing can fall just
below the calibrated threshold, and the assistant refuses rather than guesses. That is a measured trade-off
(2/27 false refusals locally, 1/27 with Gemini embeddings), discussed in [`docs/REPORT.md`](../docs/REPORT.md).

### Why can't the router retry after the answer started streaming?

The user has already read part of the answer. A different model would produce a different answer, and gluing
the two together would contradict what they saw. So the failure is reported (`partial_error`) instead.

### Why `createApp(...)` with so many parameters?

So tests can replace the database, the backends, the embedder and the thresholds. In production the defaults are
used. This "dependency injection by arguments" is why most tests need no network.

### Why are the console's demo keys visible in the page?

They belong to demo tenants with small quotas that are reset before a demo. Exposing them is acceptable for a
demo and stated in the report; the admin key and the private reviewer key are never bundled.

### Why Python in a TypeScript project?

Only for the one-off dataset split, because the Hugging Face `datasets` library is the canonical loader. Its
output is committed; nothing at runtime uses Python.

### Where do I find the reasoning behind a specific decision?

Search the comment above the code first (they explain *why*). Then the spec it points to (`docs/03 §5` means
section 5 of `docs/03-architecture.md`). The list of every library and its rejected alternatives is
`docs/11-tech-decisions.md`; the cuts and trade-offs are in `docs/REPORT.md`.

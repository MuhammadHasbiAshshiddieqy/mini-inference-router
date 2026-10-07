# 05 · The shared package (≈ 30 min)

Folder: [`packages/shared/src`](../packages/shared/src). Package name: `@mir/shared`.

## Why it exists

The gateway *sends* data and the console *receives* it. If each side described the data on its own, they would
drift apart: a field renamed on one side would silently break the other. So the description lives in one place,
and both import it:

```ts
import { parseSseEvent, type SseEvent } from "@mir/shared";   // in the console
import { ChatRequestSchema } from "@mir/shared";              // in the gateway
```

Because these descriptions are **Zod schemas**, each one is both a runtime check and a TypeScript type
([crash course §13](00-javascript-typescript-crash-course.md#13-zod-checking-data-at-the-edges)). The gateway
validates every event before sending it; the console validates every event it receives.

## What is inside

Start from [`index.ts`](../packages/shared/src/index.ts): it just re-exports every file.

| File | Contains | Used by |
|---|---|---|
| [`intents.ts`](../packages/shared/src/intents.ts) | The 27 intents + `out_of_scope`, as `as const` arrays, Zod enums and types | gateway (prompt, parser), console, scripts |
| [`domain.ts`](../packages/shared/src/domain.ts) | Shared vocabularies: profiles, backend ids, endpoints, **outcomes**, **attempt statuses**, **error codes**, retrieval modes, confidence levels, refusal reasons; and shapes like `Usage`, `QuotaState`, `RetrievedEntry`, `Confidence` | everything |
| [`api.ts`](../packages/shared/src/api.ts) | HTTP request bodies (`ChatRequestSchema`, `SupportRequestSchema`, `DebugOptionsSchema`), the error shape, the JSON responses, and the usage/admin views | gateway (validation), console (responses) |
| [`sse.ts`](../packages/shared/src/sse.ts) | The 10 streaming events (`SSE_EVENT_SCHEMAS`) and `parseSseEvent(name, data)` | gateway (`send`), console, eval, tests |
| [`sse-parser.ts`](../packages/shared/src/sse-parser.ts) | `createSseParser(onEvent)`: turns raw stream text (which can arrive split at any point) into events | console, eval, tests |
| [`normalize.ts`](../packages/shared/src/normalize.ts) + [`normalize.fixtures.json`](../packages/shared/src/normalize.fixtures.json) | Lowercase, strip `{{placeholders}}` and punctuation, collapse spaces — used for trigram matching | gateway, scripts, **and the Python data script** |
| [`dataset.ts`](../packages/shared/src/dataset.ts) | Schemas for the rows in `data/*.jsonl` | scripts, tests |

## A pattern to recognise: constant → schema → type

```ts
export const OUTCOMES = ["ok", "ok_after_fallback", "refused", …] as const;   // 1. the list, once
export const OutcomeSchema = z.enum(OUTCOMES);                                 // 2. a runtime check
export type Outcome = z.infer<typeof OutcomeSchema>;                           // 3. the TS type: "ok" | …
```

The array is also handy at runtime (the console builds its outcome filter from `OUTCOMES`).

## One rule that crosses languages

`normalize()` exists twice: in TypeScript here and in Python in `scripts/prepare_data.py` (which split the
dataset). They must produce identical output, so both are tested against the **same** fixtures file. If you
change one, change the other and the fixtures together.

## It must run in the browser too

The console imports this package, so it may not use Node-only APIs (files, `process`, `crypto`). Its main
`tsconfig.json` therefore has no Node types; a second config (`tsconfig.test.json`) adds them for the tests,
which do read files.

## Try it

Open `sse.test.ts` and `api.test.ts`: short, readable tests that show what is accepted and rejected. Then run:

```bash
cd packages/shared && pnpm exec vitest run
```

Next: [06 · The console (Vue)](06-console.md).

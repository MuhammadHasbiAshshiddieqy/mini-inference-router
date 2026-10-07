# 08 · Tests (≈ 30 min)

The project has 200+ automated tests written with **Vitest**. Reading them is one of the fastest ways to learn
what the code is supposed to do: each test name is a sentence about the behaviour.

## Four layers

| Layer | What it checks | Speed | Examples |
|---|---|---|---|
| **Pure unit tests** | Decision functions with no I/O | milliseconds | `router/plan.test.ts`, `assistant/assistant-pure.test.ts` (parser fixtures, every row of the confidence table), `config/pricing.test.ts`, `packages/shared/src/*.test.ts`, `scripts/lib/*.test.ts` |
| **Component tests with fakes** | One component with its collaborators replaced | fast | `router/execute.test.ts` (fake backends + fake timers), `embeddings/embeddings.test.ts` (fake HTTP) |
| **Contract tests with recorded data** | Our adapters understand the real providers' responses | fast, offline | `backends/adapters.test.ts` with `backends/fixtures/` (recorded from Gemini and Ollama) |
| **Integration tests with a real database** | The whole HTTP path: middleware, SQL, streaming | ~1–2 s | `request-path.test.ts` (auth, quota, metering, admin), `routes/chat.test.ts`, `assistant/support.test.ts` |
| *(opt-in)* **live smoke** | One real call per provider | seconds, costs quota | `backends/live.test.ts`, only with `LIVE=gemini\|ollama\|1` |

## Techniques you will see

**Building the app with fakes.** Integration tests call `createApp({ env, logger, getPool, registry, … })` with
a silent logger, the test database, and a registry of fake or scripted backends. No network is needed:

```ts
const { app } = buildApp([{ text: "Hello" }, { usage: [40, 6] }]);              // a scripted "ollama"
const res = await app.request(new Request("http://gateway.test/v1/chat", { method: "POST", … }));
```

`app.request(...)` sends a request straight into Hono without opening a port.

**Fake timers.** `vi.useFakeTimers()` replaces `setTimeout` with a clock the test controls, so "wait 8 seconds
for the TTFT timeout" takes no time at all:

```ts
const r = run({ "gemini-3.5-flash": stalled, "gemini-3-flash": ok() });
await vi.advanceTimersByTimeAsync(1_000);     // the TTFT timeout fires
expect((await r.promise).attempts.map((a) => a.status)).toEqual(["timeout_ttft", "ok"]);
```

**A synthetic knowledge base.** `assistant/support.test.ts` inserts 10 KB rows with hand-made vectors and uses a
fake embedder that maps known questions to known vectors. That makes "a typo the embedding gets wrong is rescued by
trigram ranking" a deterministic test.

**Failing on purpose.** To test "the database is down → 503 and no model call", a test passes a `Queryable` whose
`query()` rejects. To test the concurrency guarantee, a test fires 15 requests in parallel at a quota for 5.

**Parsing the stream.** Tests read the SSE body with the shared `parseSseText()` and validate each event with
`parseSseEvent()`, exactly like the console.

## Running tests

```bash
pnpm -r test                                         # everything (DB tests skip with a warning if Postgres is down)
REQUIRE_DB=1 pnpm -r test                            # make that a failure instead
cd apps/gateway && pnpm exec vitest run src/router   # one folder
pnpm exec vitest run src/router/execute.test.ts -t "TTFT"   # tests whose name matches
pnpm exec vitest src/assistant                       # watch mode while you edit
```

## Writing your first test

Add a case to [`apps/gateway/src/config/pricing.test.ts`](../apps/gateway/src/config/pricing.test.ts):

```ts
it("a free local backend costs nothing", () => {
  expect(costUsd(priceTable("0").ollama, { promptTokens: 5000, completionTokens: 500, thinkingTokens: 0 })).toBe("0.00000000");
});
```

Run `pnpm exec vitest run src/config/pricing.test.ts` from `apps/gateway`. Then make it fail on purpose (change
`"0"` to `"1"`) and read the error message Vitest prints: expected vs received.

## The rule about tests

From [`CLAUDE.md`](../CLAUDE.md): **never weaken a failure path to make a test pass.** If a test about auth, quota
or fallback fails, the code is wrong until proven otherwise. Several real bugs in this project were found this
way: an SSE header silently overwritten by a middleware, a stream parser that ended an event early when a line
ending was split across two chunks, a dense-rank tie order.

Next: [09 · Hands-on exercises](09-exercises.md).

# 07 · Scripts, data and evaluation (≈ 30 min)

Folders: [`scripts/`](../scripts), [`data/`](../data), [`eval/`](../eval).

## Where the data comes from

The dataset is Bitext's customer-support set on Hugging Face: 26,872 question/answer pairs over 27 intents.
[`scripts/prepare_data.py`](../scripts/prepare_data.py) (Python, run **once**) split it at a pinned version:

| File in `data/` | Rows | Purpose |
|---|---|---|
| `kb.jsonl` | 1,350 (50 per intent) | the **knowledge base** the assistant searches |
| `dev.jsonl` | 270 (10 per intent) | **calibration** of refusal thresholds — never reported |
| `eval.jsonl` | 27 (1 per intent, chosen with typos/colloquial/offensive flags) | **evaluation** — never used for tuning |
| `dev_oos.jsonl`, `eval_oos.jsonl` | 15 / 5, handwritten | out-of-scope questions (weather, poems, prompt injection…) |
| `split_manifest.json` | — | dataset version, seed, counts: how to reproduce the split |

Each line of a `.jsonl` file is one JSON object (`{"id":"bitext-00893","instruction":"…","response":"…","intent":"cancel_order",…}`).
Rows that are the same after normalization never appear in two splits — otherwise the evaluation would test the
assistant on questions it has already seen. Everything in `data/` is committed, so nobody needs Python or a
network connection to run the project.

Keeping dev and eval apart is the most important rule of the evaluation: thresholds are tuned on dev, numbers
are reported on eval. Tuning on the test set would make the numbers look better than reality.

## From files to the database

```
data/kb.jsonl ──► pnpm kb:embed -- --provider ollama|gemini ──► data/embeddings/<model>.f32 (cache) ──► kb_entries
```

[`scripts/embed_kb.ts`](../scripts/embed_kb.ts) embeds each KB question, stores the vectors in a binary cache
(`.f32` = raw 32-bit floats, 1,350 × 768 × 4 bytes) with a `.meta.json` describing it, then upserts the rows into
Postgres. The cache is committed, so `--from-cache-only` loads the KB without calling any model (the Docker setup
does this). If the cache is missing or `kb.jsonl` changed, it rebuilds; if a build is interrupted (for example by
a free-tier rate limit), re-running resumes where it stopped. The cache logic is in
[`scripts/lib/embedding-cache.ts`](../scripts/lib/embedding-cache.ts) and tested.

## Calibration

[`scripts/calibrate.ts`](../scripts/calibrate.ts) embeds the dev questions, finds each one's best KB match, and
computes the refusal thresholds (`T_oos`, `T_high`, `T_trgm_oos`) into [`data/thresholds.json`](../data/thresholds.json).
The maths is three small functions in [`scripts/lib/calibration.ts`](../scripts/lib/calibration.ts). See
[gateway chapter 05](04-gateway/05-support-assistant.md#step-3--the-pre-gate-refuse-before-spending-anything) for how they are used.

## Three kinds of evaluation

| Script | Calls a model? | Answers the question |
|---|---|---|
| [`eval-retrieval.ts`](../scripts/eval-retrieval.ts) (`pnpm eval:retrieval`) | no, only embeddings | Which retrieval mode finds the right intent most often? (297 queries) → chose `dense` |
| [`eval.ts`](../scripts/eval.ts) (`pnpm eval -- --label <name>`) | yes, through a running gateway | End to end: intent accuracy, refusals, answer similarity, latency, cost (32 cases) |
| [`eval-compare.ts`](../scripts/eval-compare.ts) (`pnpm eval:compare -- a.json b.json`) | no | Writes [`eval/report.md`](../eval/report.md): two configurations side by side |

`eval.ts` talks to the gateway exactly like a client (HTTP, streaming), so it measures the real path including
auth, quota and metering, and measures time to first token from the client side. It never uses debug options.
Results go to `eval/results/<label>.json` with every case and the gateway's `/healthz` fingerprint.

Aggregates are computed by [`scripts/lib/eval-aggregate.ts`](../scripts/lib/eval-aggregate.ts) from the per-case
records, and `eval:compare` recomputes them, so a definition fix applies to old runs too. One example of why that
matters: answers served by the mock backend carry the kNN intent by construction, so they would inflate "model
accuracy"; the aggregates therefore report real-model answers separately.

Read [`eval/report.md`](../eval/report.md) and the "Evaluation" section of [`docs/REPORT.md`](../docs/REPORT.md)
for the results and what they mean (including the small-sample caveat: one case = 3.7 percentage points).

## The smoke test

[`scripts/smoke.sh`](../scripts/smoke.sh) is a bash script that checks any running gateway from the outside with
`curl`: health, 401s, a 400, a streamed answer, forced fallback, mock fallback, tenant policy, refusal, lexical
fallback, quota exhaustion, and the recorded attempts. It prints PASS/FAIL per check and is meant to be run after
every deploy.

## Small helpers

- [`scripts/lib/cli.ts`](../scripts/lib/cli.ts) — parse command-line flags and the few env vars a script needs; print a clear error and exit.
- [`scripts/lib/retry.ts`](../scripts/lib/retry.ts) — retry a call that hit a rate limit (HTTP 429).
- [`scripts/migrate.ts`](../scripts/migrate.ts), [`scripts/seed.ts`](../scripts/seed.ts) — see [gateway chapter 06](04-gateway/06-database.md).

The scripts import gateway code directly by path (`../apps/gateway/src/...`), so the embedding adapters, the
retrieval SQL and the database client are the same code the server runs — no duplicated logic.

Next: [08 · Tests](08-tests.md).

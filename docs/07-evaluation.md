# 07 — Evaluation

Goal (R18–R20): ~30 held-out cases, a script that reports **intent accuracy, answer quality, latency and cost**,
run against **two configurations** and compared. The eval goes **end-to-end through the gateway HTTP API**, so it
measures the real request path (auth, quota, retrieval, routing, streaming, metering).

## 1. Cases

- `data/eval.jsonl`: 27 in-domain cases (1 per intent, hard flags preferred; see doc 02).
- `data/eval_oos.jsonl`: 5 out-of-scope cases (expected: refusal).
- Total: 32. Never used for calibration or prompt tuning.

## 2. Configurations

A configuration = a gateway started with a given env. The eval script reads `GET /healthz` and stores the **config fingerprint**
(profile, backend ids + models, thinking level, embedding model, prompt version, thresholds) with the results, so every number is traceable.

Recommended comparison (pick one pair; the first is the default):

| Label | What changes | Question it answers |
|---|---|---|
| **A `cloud-minimal`** vs **B `local-ollama`** | Gemini 3.5 Flash (thinking minimal) vs Ollama `gemma4:e2b-mlx` natively on the Mac | Is a free local model good enough to be primary, and what does cloud buy in quality vs latency? (Retrieval differs too, because the embedding model differs. Report retrieval hit@k separately so the effects are not confused.) |
| A `cloud-minimal` vs C `cloud-low` | `GEMINI_THINKING_LEVEL` minimal vs low | Is the extra thinking worth its latency and cost? Directly justifies the default + escalation design. |

If time allows, run all three and present a 3-column table.

## 2b. Retrieval-only eval: dense vs hybrid (no LLM calls)

The end-to-end eval has n=27 in-domain cases (1 case = 3.7 pp), too small to show a retrieval difference. Retrieval is
deterministic and does not need the LLM, so it gets its own cheap, larger evaluation that **decides `RETRIEVAL_MODE`**:

```
pnpm eval:retrieval -- --embedding nomic-embed-text|gemini --sets dev,eval,dev_oos,eval_oos
```

- Runs each query through `retrieve()` in all three modes: `dense`, `hybrid`, `lexical` (trigram only, i.e. the fallback).
- In-domain set: `dev` (270) + `eval` (27) = **297 queries**. OOS set: `dev_oos` (15) + `eval_oos` (5) = 20.
- Metrics per mode: **hit@1, hit@5, MRR@5** (gold intent among retrieved intents), **kNN intent accuracy** (dense-weighted vote),
  **pre-gate OOS recall** and **in-domain false-gate rate** at the calibrated thresholds, broken down by **hard flags** (Z, Q, K, W) vs others,
  and on the confusable intent pairs (doc 02 §3).
- Caveat: `dev`/`dev_oos` were used to calibrate thresholds. Ranking metrics (hit@k, MRR) are threshold-free and valid on dev.
  Gate metrics are reported on `eval*` only (small n, stated).
- Cost: only query embeddings. Use the local `nomic-embed-text` (free, unlimited) for the main comparison and the Gemini embedding on the eval project if RPD allows.
- Output: `eval/results/retrieval-<embedding>.json` + a table in `eval/report.md`.

**Decision rule** (write the outcome in the report):
- Switch the default to `hybrid` only if hybrid improves **hit@1 or kNN intent accuracy by ≥ 1 pp overall, or ≥ 3 pp on hard-flag queries**,
  **and** does not reduce OOS gate recall or raise the in-domain false-gate rate. (Gating is dense in both modes, so a change here would indicate a bug.)
- Otherwise keep `dense` and report hybrid as "measured, no gain on this dataset". That is still a valid, evidence-based outcome.
- The `lexical` column documents how much quality the fallback loses (expected: noticeably lower), which justifies the medium-confidence cap.

### Result (2026-10-06, `nomic-embed-text`, `eval/results/retrieval-nomic-embed-text.json`)

| in-domain n=297 | dense | hybrid | lexical | hybrid − dense |
|---|---|---|---|---|
| hit@1 | 96.0% | 94.9% | 89.9% | −1.0 pp |
| kNN intent accuracy | 96.6% | 94.9% | 91.2% | −1.7 pp |
| kNN accuracy, hard flags (n=165) | 95.2% | 92.7% | 90.3% | −2.4 pp |
| kNN accuracy, confusable (n=143) | 97.2% | 94.4% | 93.7% | −2.8 pp |
| OOS gate recall (eval, n=5) / false-gate (eval, n=27) | 100% / 7.4% | 100% / 7.4% | 100% / 7.4% | 0 |

**Decision: `RETRIEVAL_MODE=dense`** ("measured, no gain on this dataset"). Hybrid is worse on every ranking metric, including hard-flag (typo) queries: the queries are short, placeholders are stripped, and trigram overlap on generic words ("order", "refund") pulls in neighbouring intents. Gate metrics are identical by construction (gating is dense in both). Lexical fallback loses ~6 pp hit@1, which supports capping its confidence at `medium`.

## 3. Metrics (per config)

| Metric | Definition |
|---|---|
| **Intent accuracy** | in-domain cases where `final_intent == gold` (refusals count as wrong) / 27. Also report kNN-only accuracy and LLM-header accuracy separately. |
| **Retrieval hit@1 / hit@5** | gold intent is the top-1 / within the top-5 retrieved intents (for the active `RETRIEVAL_MODE`; see §2b for the mode comparison) |
| **Refusal** | OOS refusal rate (refused OOS / 5) and in-domain false-refusal rate (refused in-domain / 27) |
| **Answer quality (1): semantic similarity** | cosine(answer, gold `response`) using **one fixed scorer embedding model for all configs** (Gemini embedding, or nomic if offline; state which). Report the mean and the distribution. Only for answered in-domain cases. |
| **Answer quality (2): LLM judge** (P1, **cut**: first item of the cut order; it would spend free-tier quota and add a self-preference bias) | judge = `gemini-3.5-flash` with thinking `low`, temperature default. Rubric JSON `{correctness 1–5, groundedness 1–5, placeholder_fidelity 0/1, reason}` given the question, the gold response and the top-3 references. Mean scores. State the self-preference bias risk (same family as one generator). |
| **Latency** | TTFT and total, p50 / p95 (client-measured), plus server-reported values from `done` |
| **Tokens** | mean prompt / completion / thinking per case |
| **Cost** | total and mean USD per case (list-price equivalent), extrapolated per 1,000 requests |
| **Reliability** | fallback rate, escalation rate, error rate, outcome counts |

## 4. Runner (`scripts/eval.ts`)

```
pnpm eval -- --label cloud-minimal --gateway http://localhost:8787 --key $SEED_KEY_EVAL \
             [--concurrency 1] [--delay-ms 4000] [--judge] [--limit N]
```

- Runs sequentially by default (free-tier RPM limits). Configurable delay. Retries a case once on 429 after backoff, then records it as an error (never silently drops it).
- Uses the **streaming** endpoint and a shared SSE parser, measuring TTFT client-side.
- Writes `eval/results/<label>.json` (fingerprint, per-case records, aggregates) and prints a summary table.
- `pnpm eval:compare -- eval/results/A.json eval/results/B.json` → writes `eval/report.md` with:
  1. config fingerprints side by side;
  2. the aggregate metrics table (A | B | Δ);
  3. a per-intent correctness grid (✓/✗ per config);
  4. the list of disagreements between configs with the case text;
  5. notes on leakage and small-sample caveats (n=27 → one case = 3.7 pp; avoid over-claiming).
- Before running: `pnpm db:seed --reset-usage` so the eval tenant has its full quota.
- The eval tenant has `allow_debug`, but the eval must **not** use debug overrides. It measures the real path.

### Built (Phase 8)

`scripts/eval.ts` (runner), `scripts/eval-compare.ts` (report), `scripts/eval-retrieval.ts` (retrieval-only), metrics in `scripts/lib/eval-metrics.ts` (unit-tested). The scorer is fixed to `nomic-embed-text` for every configuration (it needs local Ollama while scoring). Mean token counts are per request that reached a model (pre-gate refusals excluded); cost per 1,000 requests uses all cases, because free refusals are part of the real mix.

Config B `local-ollama` (2026-10-06): intent accuracy 88.9% (kNN alone 100%, LLM header 96%), OOS refusal 100%, in-domain false refusal 7.4% (2 hard-flag cases pre-gated at dense top-1 0.653 and 0.637 < T_oos 0.668), answer similarity 0.895, TTFT p50 1.13 s, escalation 3.1%. The third miss: "I'm trying to get my damn bills" — kNN `get_invoice` (right), LLM `check_invoice` twice; top-1 0.80 ≥ T_high but vote share < 0.8, so the table answers with the LLM intent.

Config A `cloud-minimal` (2026-10-06, local gateway with `PROFILE=cloud`): **run 1** — `gemini-3.5-flash` answered 14 in-domain cases, all with the right intent (header accuracy 14/14), answer similarity 0.910, TTFT p50 4.2 s on first-try answers (Gemini reported 503 "high demand" in the same window); after ~20 attempts the **free-tier daily generation quota (20 requests/day/project/model)** ran out and the mock answered the remaining 12. In-domain false refusal 3.7% (1/27: "recover_password", top-1 below T_oos 0.768). **Run 2** (same day) got no Gemini answer at all (quota spent): 26/26 answers from the mock, fallback 81%, zero errors — evidence for the availability path, not for model quality. `eval/report.md` compares run 1 with config B; rows marked "excl. mock" isolate the real model. Since eval aggregates are now recomputed from per-case records (`scripts/lib/eval-aggregate.ts`), mock-served cases are excluded from the LLM-header and real-model rows.

## 5. Unit tests vs eval

Unit and integration tests prove correctness of mechanics (auth, quota, fallback, parsing) deterministically with fakes.
The eval measures **quality and cost** on real models. The report shows both.

## 6. Reporting in `docs/REPORT.md`

Copy the comparison table from `eval/report.md` and add a short interpretation:
which config you chose as default and why (numbers), what failed and why (look at the disagreement cases), and what you would try next.

# Gateway 05 · The support assistant (≈ 40 min)

Files: `assistant/retrieve.ts`, `assistant/intent.ts`, `assistant/confidence.ts`, `assistant/prompt.ts`,
`assistant/parse.ts`, `assistant/answer.ts`, `assistant/readiness.ts`, `routes/support.ts`, `embeddings/*`,
`config/thresholds.ts`.

The assistant answers one customer message using a **knowledge base (KB)** of 1,350 real question/answer pairs,
and returns the **intent** (one of 27 labels like `cancel_order`, or `out_of_scope`) plus a **confidence** level.
When it is not confident, it **refuses** instead of guessing. This is "RAG": *retrieval-augmented generation* —
find relevant examples first, then let the model write an answer based on them.

## Step 1 · Embeddings: turning text into numbers

An **embedding model** turns a sentence into a list of 768 numbers (a *vector*) so that sentences with similar
meaning get similar vectors. "I want to cancel my order" and "please cancel purchase 123" end up close
together; "write me a poem" ends up far away.

Closeness is measured with **cosine similarity**: 1.0 = same direction (same meaning), ~0 = unrelated. All
vectors are scaled to length 1 ("L2-normalized"), which makes the maths simple.

- Locally the embedding model is `nomic-embed-text` (via Ollama); in the cloud it is `gemini-embedding-001`.
- The two models produce *different* vector spaces, so every KB row stores which model made it
  (`kb_entries.embedding_model`), and queries are only compared with rows of the same model.
- Code: [`embeddings/`](../../apps/gateway/src/embeddings/) — one adapter per provider, plus `checkVectors()` which
  refuses a response with the wrong number of vectors or dimensions (it caught a real model returning one vector
  for three inputs).

Only the KB **questions** (`instruction`) are embedded: matching a user's question to similar *questions* works
better than to long answers. The answers come along as context for the model.

## Step 2 · Retrieval: find the 5 closest KB entries

[`assistant/retrieve.ts`](../../apps/gateway/src/assistant/retrieve.ts). The vectors live in Postgres thanks to the
**pgvector** extension, so a search is one SQL query:

```sql
SELECT id, intent, instruction, response, 1 - (embedding <=> $1::vector) AS dense_sim
FROM kb_entries WHERE embedding_model = $2
ORDER BY embedding <=> $1::vector, id LIMIT $3        -- <=> is pgvector's cosine DISTANCE (0 = identical)
```

Three modes exist:

| Mode | How it ranks | When |
|---|---|---|
| `dense` | cosine similarity of the vectors | **the default** (it won the retrieval evaluation) |
| `hybrid` | dense + *trigram* text similarity (`pg_trgm`), merged with **RRF** (reciprocal rank fusion: add `1/(60 + rank)` from each list) | available, but measured worse on this data |
| `lexical_fallback` | trigram similarity only (shared letter triples: tolerant to typos) | automatically, when the embedding call fails twice |

The result also carries **signals** computed by [`assistant/intent.ts`](../../apps/gateway/src/assistant/intent.ts):

- `top1Similarity` — how close the best match is;
- `knnIntent` — the intent that wins a vote among the 5 entries, each vote weighted by its similarity
  ("k-nearest neighbours");
- `voteShare` — how much of the vote it got (1.0 = all five agree).

**Ranking is separated from gating.** Whatever orders the list, the *decisions* (refuse or not, the vote) always
use the dense cosine similarity, whose scale was calibrated. RRF scores have no absolute meaning ("0.032" is not
"close" or "far"), so they are never compared with a threshold.

## Step 3 · The pre-gate: refuse before spending anything

[`assistant/confidence.ts`](../../apps/gateway/src/assistant/confidence.ts) → `preGate()`. If the best match is
below a threshold `T_oos` ("out of scope"), the request is refused immediately: no model call, 0 tokens.
"Write me a poem" or a prompt-injection attempt stops here.

Where does `T_oos` come from? From **calibration** ([`scripts/calibrate.ts`](../../scripts/calibrate.ts)): run 270
known in-domain questions and 15 out-of-scope ones from the *dev* split, and pick the highest threshold that still
lets 98% of the in-domain questions through. Results are stored in [`data/thresholds.json`](../../data/thresholds.json)
per embedding model (e.g. `nomic-embed-text`: 0.668; `gemini-embedding-001`: 0.768) and loaded by
[`config/thresholds.ts`](../../apps/gateway/src/config/thresholds.ts). The evaluation cases are never used for this.

## Step 4 · The prompt and the output format

[`assistant/prompt.ts`](../../apps/gateway/src/assistant/prompt.ts). The system prompt (`PROMPT_V1`) tells the model
to answer only from the references and to reply in a strict format:

```
INTENT: cancel_order
---
To cancel order {{Order Number}}, open Orders and choose Cancel…
```

The user message contains the 5 references (question, answer, intent, similarity) and the customer message
wrapped in `<customer_message>` tags, with an instruction to treat it as data (a defence against "ignore your
instructions…"). `{{Order Number}}`-style placeholders are kept on purpose: the dataset uses them as template
slots, and the model must never invent real order numbers or phone numbers.

Why a text header instead of JSON? With JSON the answer could not be streamed until the JSON closed. With a
header, the intent arrives first and the answer can stream right after.

## Step 5 · The parser: nothing is shown until the header is valid

[`assistant/parse.ts`](../../apps/gateway/src/assistant/parse.ts) → `SupportOutputParser`, a small **state
machine** fed with text chunks: `header` → `separator` → `body`.

- In `header` it buffers text (nothing reaches the user) until a full line arrives, then checks it with a regular
  expression. It tolerates `**INTENT:**` bold, blank lines, upper case, and a `Line 1:` / `Line 2:` prefix (a
  real model copied those words from the prompt). The label must be one of the 28 allowed values.
- It then requires a `---` line, then passes body text through.
- Anything else — "Sure! Here is…", JSON, an unknown label, more than 200 characters without a header, an empty
  answer — throws `InvalidOutputError`.

All the bad outputs it must handle are listed as test cases in `assistant-pure.test.ts`.

## Step 6 · The decision table

`decideOnHeader(llmIntent, signals, escalated, thresholds)` in `confidence.ts`:

| Situation | Decision |
|---|---|
| model says `out_of_scope` | refuse (`model_out_of_scope`) |
| model agrees with kNN, vote ≥ 0.6 | answer, confidence **high** |
| model agrees with kNN, vote < 0.6 | answer, **medium** |
| model disagrees, first time | **escalate** (retry once) |
| still disagrees, and the KB evidence is strong (top-1 ≥ `T_high` and vote ≥ 0.8) | refuse (`intent_disagreement`) |
| still disagrees, otherwise | answer with the model's intent, **medium** |
| output unusable, first time / second time | escalate / refuse (`unusable_model_output`) |

In lexical-fallback mode, `high` is capped at `medium` (text overlap is weaker evidence than meaning).
Two independent signals (the KB vote and the model) give a confidence grounded in data, instead of asking the
model "how sure are you?", which models answer poorly.

## Step 7 · Putting it together: `assistant/answer.ts`

[`runSupport()`](../../apps/gateway/src/assistant/answer.ts) is the orchestration (≈ 400 lines; skim it with the
steps above in mind):

```
retrieve()  → send "retrieval" event
preGate()   → refuse? send "refusal", settle with 0 tokens, done
loop at most twice:
    execute(candidates, request with PROMPT_V1 [+ FORMAT_REMINDER and thinking "low" if escalated],
            hooks: onRoute → new parser
                   onChunk → parser.push(text):
                       header → decideOnHeader(): answer / stop to escalate / stop to refuse
                       first body text → commit (no more fallback), send "intent", then "token"s
                   onEnd → parser.finish() (may reject a truncated answer))
    ok        → done
    stopped   → escalate once (same backend first, then the rest of the plan) or refuse
    failures  → send "error" (partial_error / all_backends_failed)
settle() → reconcile quota, write intent/confidence/retrieved ids/retrieval mode → send "done"
```

Details worth noticing:

- **Stopping is a quality decision, not a failure.** To escalate or refuse after the header, the consumer throws a
  non-retryable `BackendError`; the router records it and stops without falling back.
- **The `intent` event is sent at the commit point**, so a failure during the header phase (followed by
  fallback) never produces two intent events.
- **The mock answers sensibly**: header = the kNN intent, body = the best KB answer. When every real model is
  down or out of quota, users still get a grounded (if generic) answer, clearly labelled MOCK.

[`routes/support.ts`](../../apps/gateway/src/routes/support.ts) wires it like `chat.ts`: admission (with a check
that thresholds exist → **503 `assistant_unavailable`** otherwise), then SSE or JSON.
[`assistant/readiness.ts`](../../apps/gateway/src/assistant/readiness.ts) is what `/healthz` uses to say whether
the assistant can work.

## Try it

```bash
curl -s localhost:8787/v1/support/answer -H "authorization: Bearer $SEED_KEY_ACME" -H "content-type: application/json" \
  -d '{"message":"Has my refund been processed yet?","stream":false}' | node -e \
  "process.stdin.on('data',d=>{const v=JSON.parse(d);console.log(v.intent,v.confidence?.level,v.retrieved.map(r=>r.intent))})"
# then try: an out-of-scope question, a prompt injection, and the same question with
#   "debug":{"force_embedding_fail":true}   → retrieval_mode lexical_fallback, confidence medium
```

Next: [06 · The database](06-database.md).

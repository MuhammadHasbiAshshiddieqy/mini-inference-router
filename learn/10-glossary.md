# 10 · Glossary

Terms in alphabetical order, explained for this project.

| Term | Meaning here |
|---|---|
| **Admission** | Everything a request must pass before work starts: validation, tenant policy, routing plan, quota reservation, the `in_progress` row. Code: `http/admission.ts` (`admit`). Its counterpart at the end is `settle`. |
| **AppError** | The error type for anything the client should see: a code (`quota_exceeded`), an HTTP status (429) and a message. |
| **Async generator** | A function (`async function*`) that produces values over time with `yield`; how model output is streamed. |
| **Attempt** | One try of one backend for one request. A request can have several (fallback, escalation). Stored in `route_attempts`. |
| **Backend** | A source of model answers behind a common interface: Gemini, Ollama or Mock. Identified by a stable id (`gemini-3.5-flash`) separate from its model name. |
| **Calibration** | Choosing refusal thresholds from data (the dev split) instead of guessing. `scripts/calibrate.ts`. |
| **Commit point** | The moment the first piece of an answer is shown to the user. Before it, the router may fall back; after it, it may not. |
| **Confidence** | `high` / `medium` / `low`, from the agreement between the model's intent and the knowledge-base vote, the vote share and the similarity. Not the model's self-assessment. |
| **Cosine similarity** | How similar two vectors' directions are: 1 = same meaning, ~0 = unrelated. pgvector's `<=>` returns the *distance* (1 − similarity). |
| **CORS** | Browser rule: a page from one origin (port/domain) may call another only if that server allows it. The gateway allows the console's origin. |
| **Dense retrieval** | Searching by embedding similarity (meaning). The default mode. |
| **Dev / eval split** | Data used to tune (dev) vs data used to report results (eval). Never mixed. |
| **Drizzle** | The TypeScript library that defines the tables and generates/applies SQL migrations. |
| **Embedding** | A list of numbers (here 768) representing a text's meaning. Made by an embedding model (`nomic-embed-text`, `gemini-embedding-001`). |
| **Escalation** | Retrying *once* on the same backend with more thinking and a format reminder, because the *answer* was unusable or disagreed with retrieval. Contrast with fallback. |
| **Fail closed** | When the system cannot check something (e.g. the database is down), it refuses instead of allowing. The opposite, "fail open", would serve requests without a quota. |
| **Fallback** | Trying the next backend because the current one *failed* (error, rate limit, timeout). |
| **Fixture** | Stored example data used by tests (e.g. recorded Gemini responses). |
| **Hono** | The small web framework of the gateway. |
| **Hybrid retrieval** | Dense + lexical (trigram) results merged with RRF. Implemented, measured, not the default. |
| **Intent** | The kind of request: one of 27 labels (`cancel_order`, `track_refund`…) or `out_of_scope`. |
| **JSONL** | A file with one JSON object per line. The data splits use it. |
| **kNN intent** | "k nearest neighbours": the intent most common among the 5 retrieved entries, weighted by similarity. |
| **Knowledge base (KB)** | The 1,350 question/answer pairs the assistant searches (`kb_entries`). |
| **Lexical fallback** | Retrieval by text overlap (trigrams) only, used automatically when the embedding service fails. Confidence is capped at medium. |
| **Metering** | Recording what each request did: model, tokens, latency, cost, outcome (`requests`, `route_attempts`). |
| **Middleware** | A function that runs for many routes before/after the handler (auth, request id, size limit). |
| **Mock backend** | A fake model inside the gateway, used as a last-resort answer and to demonstrate fallback deterministically. |
| **Monorepo / workspace** | Several packages in one repository, linked by pnpm. |
| **Ollama** | A program that runs open models locally and exposes an HTTP API. |
| **Outcome** | The final result of a request: `ok`, `ok_after_fallback`, `refused`, `quota_exceeded`, `invalid_request`, `all_backends_failed`, `partial_error`, `client_aborted`, `internal_error`. |
| **pgvector** | Postgres extension that stores vectors and searches them by similarity. |
| **pg_trgm** | Postgres extension for trigram (3-letter chunk) text similarity; tolerant to typos. |
| **Placeholder** | `{{Order Number}}`-style slots in the dataset's answers. Kept on purpose; never replaced with invented values. |
| **pnpm** | The package manager. Stores each package version once and links it into each project's `node_modules`. |
| **Pre-gate** | The refusal check before any model call: if the best KB match is too far, refuse with 0 tokens. |
| **Profile** | `local`, `cloud` or `hybrid`: which backends and embedding model are used. |
| **Quota (token budget)** | How many tokens a tenant may use in total. Checked and reserved atomically before work. |
| **RAG** | Retrieval-augmented generation: retrieve relevant examples, then let a model answer using them. |
| **Reconcile** | After a request, replacing the reserved tokens with the actual tokens used. |
| **Refusal** | A deliberate "I'm not confident" answer instead of a guess. Reasons: `low_retrieval_similarity`, `model_out_of_scope`, `intent_disagreement`, `unusable_model_output`. |
| **RRF** | Reciprocal Rank Fusion: merge two ranked lists by adding `1/(60 + rank)` from each. |
| **Serverless** | Hosting where code runs per request without a permanent server (Vercel). Memory is not shared between instances. |
| **SSE** | Server-Sent Events: a long HTTP response carrying a stream of small text events. |
| **Tenant** | A customer of the gateway (a product team), with its own key, quota and permissions. |
| **Thinking tokens** | Tokens a model like Gemini spends reasoning before answering. Billed as output; never shown. |
| **Threshold** | A similarity value below which the assistant refuses (`T_oos`) or above which evidence counts as strong (`T_high`). |
| **Token** | A piece of text (≈ 4 characters in English) — the unit models count and bill. |
| **TTFT** | Time to first token: how long until the first piece of the answer appears. |
| **Type stripping** | Node removing TypeScript type annotations when it loads a `.ts` file, so TS runs without a build step. |
| **UUIDv7** | A unique id that starts with a timestamp, so ids sort by creation time. Used as the request id. |
| **Vite** | The console's dev server and build tool. |
| **Zod** | Library for schemas that validate data at runtime and provide TypeScript types. |

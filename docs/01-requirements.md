# 01 — Requirements (source of truth)

Source: the assessment brief (PDF), plus the recruiter email.
The original text is quoted first. The traceability matrix after it is how we satisfy each item.

## 1. Original brief (verbatim)

> **Code Challenge: Mini Inference Router**
>
> **Case study.** Our products call language models through one shared gateway instead of talking to providers directly.
> The gateway picks which model backend serves a request, enforces what each tenant is allowed, records what the request
> cost, and exposes task capabilities that product teams call without knowing which model answered.
>
> Build a small version of that, with one capability on top of it: a customer support assistant that answers a customer
> message from a support knowledge base and returns the detected intent.
>
> Dataset: Bitext customer support dataset, around 27,000 question and answer pairs across 27 intents. Use a slice as the
> knowledge base and a held-out slice for evaluation.
>
> **What to build**
>
> *Gateway*
> - Chat endpoint with streaming, authenticated by a per-tenant API key
> - Per-tenant quota that fails closed with a clear error
> - Metering per request: model used, tokens, latency, estimated cost, outcome, stored in a database
>
> *Routing*
> - At least two model backends, with rules you can defend for choosing between them
> - Fallback when a backend fails or is too slow, with the decision recorded and inspectable
>
> *Support assistant*
> - Retrieval over the knowledge base slice
> - Returns answer, detected intent, retrieved entries, and a confidence signal
> - Handles the case where the model returns something unusable, and refuses instead of guessing when confidence is low
>
> *Console (Vue, React, or Next.js, back end Node js)*
> - Chat playground where the answer streams in and you can see which model served it, whether fallback fired, what was
>   retrieved, the intent, tokens, latency, and cost
> - A simple usage view: requests and cost per tenant, and remaining quota
>
> *Evaluation*
> - Around 30 held-out cases, with a script that reports intent accuracy, answer quality by a method of your choosing,
>   latency, and cost
> - Run it against two configurations, for example two prompts or two models, and compare
>
> **Constraints**
> - We do not provide LLM API keys. You may use a local model (Ollama or similar), a provider free tier, or both. A mock
>   backend with configurable latency and failure is a fine second backend, and the easiest way to show fallback working.
>   At least one real model must serve real requests.
> - Deploy it. Vercel, Render, or anything similar. Give us a working URL alongside the repository.
> - One day of work. Cut scope deliberately rather than leaving things half-built, and say what you cut. A smaller system
>   that is measured beats a larger one that is untested.
>
> **Deliverables**
> - The GitHub repository link (source code and documentation) and a video demo
> - A brief technical report explaining your design choices: routing rules, model and retrieval choices, how you evaluated,
>   and the trade-offs you accepted
> - The deployed URL
>
> **What we assess**
> - Correctness of the request path: auth, quota, streaming, failure behaviour
> - Routing and fallback: reasoned rather than arbitrary, and observable
> - Measurement: tokens, latency, and cost recorded accurately, quality shown with numbers
> - Code structure and exception handling: invalid input, timeouts, bad model output
> - Judgement: what you built, what you skipped, and whether you said so

Recruiter email: submit by replying to the email **within 3 calendar days** of receipt (received Tue 6 Oct 2026 13:00 WIB → **Fri 9 Oct 2026, 13:00 WIB**).

## 2. Interpretation notes

- "One day of work" describes **effort scope**. The 3-day window is the **submission deadline**. Use the extra time for
  testing, deployment, evaluation, report and video, not for extra features.
- "back end Node js" is read as applying to the **whole backend**. That is the safest reading, so the gateway is Node/TypeScript too.
- The gateway is the product. The console is one client of it and uses tenant API keys like any product team would.
- "Fallback … too slow": we treat **time-to-first-token (TTFT) timeout** and **total timeout** as failures that trigger fallback.
- Fallback is only possible **before the first token reaches the client**. After that, a failure is reported in-stream and
  recorded. It is not silently retried, because that would duplicate or contradict text the user has already seen. We state this in the report.

## 3. Traceability matrix

Priority: **P0** = must ship. **P1** = should ship. **P2** = only if time remains (otherwise listed as a cut).

| ID | Requirement | Pri | Where implemented | Evidence |
|---|---|---|---|---|
| R1 | Chat endpoint with streaming (SSE) | P0 | `routes/chat.ts`, `http/sse.ts` | test `chat.stream.test.ts`, console playground, video |
| R2 | Per-tenant API key auth | P0 | `http/auth.ts` (hashed keys in `tenants`) | `request-path.test.ts`: missing/invalid key → 401, disabled → 403 |
| R3 | Per-tenant quota, fails closed, clear error | P0 | `quota/quota.ts` (atomic reserve + reconcile), `http/admission.ts` | `request-path.test.ts`: exhausted → 429 `quota_exceeded`; DB down → 503 `quota_unavailable`, no backend call; concurrency (3N parallel → exactly N admitted) |
| R4 | Tenant policy: "enforces what each tenant is allowed" | P0 | `tenants.allowed_backends`, `max_output_tokens` | test: disallowed backend never attempted |
| R5 | Metering: model, tokens, latency, est. cost, outcome → DB | P0 | `metering/*`, `config/pricing.ts`, tables `requests`, `route_attempts` | `request-path.test.ts` asserts rows; `pricing.test.ts`; console Requests view |
| R6 | ≥2 model backends | P0 | `backends/gemini.ts`, `ollama.ts`, `mock.ts` | profiles in `config/profiles.ts` |
| R7 | Defensible routing rules | P0 | `router/plan.ts` (pure function) | unit tests per rule; report section with eval numbers |
| R8 | Fallback on failure or slowness | P0 | `router/execute.ts` | tests: 5xx, 429, TTFT timeout, network error → next backend |
| R9 | Fallback decision recorded and inspectable | P0 | `route_attempts` rows + SSE `route`/`attempt_failed` events + `GET /admin/requests/:id` | console attempt timeline |
| R10 | At least one real model serves real requests | P0 | Gemini 3.5 Flash (cloud), Ollama (local) | deployed URL, video |
| R11 | Retrieval over KB slice | P0 | `assistant/retrieve.ts`: dense (pgvector) and hybrid (dense + pg_trgm, RRF); lexical fallback when embedding fails (P1) | retrieval-only eval over 297 queries (doc 07 §2b) + hit@k in the end-to-end eval |
| R12 | Returns answer, intent, retrieved entries, confidence | P0 | `routes/support.ts` SSE events | contract test |
| R13 | Handles unusable model output | P0 | `assistant/parse.ts` + escalation | tests with malformed fixtures |
| R14 | Refuses when confidence is low | P0 | `assistant/confidence.ts` | eval: OOS refusal rate, in-domain false-refusal rate |
| R15 | Console: streaming playground | P0 | `apps/console` Playground | video |
| R16 | Console shows model, fallback, retrieved, intent, tokens, latency, cost | P0 | Playground side panel | video |
| R17 | Usage view: requests and cost per tenant, remaining quota | P0 | Usage page via `/admin/usage` | video |
| R18 | ~30 held-out eval cases | P0 | `data/eval.jsonl` (27) + `data/eval_oos.jsonl` (5) | file + manifest |
| R19 | Eval script: intent accuracy, answer quality, latency, cost | P0 | `scripts/eval.ts` | `eval/results/*.json`, `eval/report.md` |
| R20 | Two configurations compared | P0 | e.g. Gemini 3.5 Flash vs Ollama, or thinking minimal vs low | comparison table in report |
| R21 | Input validation, timeouts, bad output handled | P0 | Zod, AbortSignal, parse.ts | tests |
| R22 | Deployed URL | P0 | Vercel (gateway + console) + Neon | README link, smoke script |
| R23 | Technical report + "What I cut" | P0 | `docs/REPORT.md` | — |
| R24 | Video demo | P0 | recorded from deployed or local | link in README |

## 4. Non-functional targets (our own, used in the report)

- Gateway overhead (auth + quota + retrieval, excluding LLM) p50 < 150 ms on the cloud deployment.
- No request is ever served without a successful quota reservation.
- Every request, including rejected ones that have a known tenant, produces exactly one `requests` row.
- Every backend attempt produces exactly one `route_attempts` row.

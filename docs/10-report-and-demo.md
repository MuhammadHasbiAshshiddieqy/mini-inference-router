# 10 — Technical Report Template, Cut Log, Demo Script, Submission

## Part A: `docs/REPORT.md` template (aim for 2–4 pages; numbers over adjectives)

```markdown
# Mini Inference Router: Technical Report

**Live:** console <url> · gateway <url> · **Repo:** <url> · **Video:** <url>

## 1. Summary
One paragraph: what was built, the headline numbers (intent accuracy, OOS refusal, p50 TTFT, cost/1k requests), and the biggest trade-off.

## 2. Architecture
Diagram (from docs/03) + 5 bullets on the request path: auth → fail-closed quota reservation → retrieval → routing/fallback → streaming → metering.

## 3. Gateway correctness
- Auth: hashed per-tenant keys; error codes.
- Quota: token budget with atomic reservation + reconcile; fail closed when the DB is unavailable; concurrency test result.
- Streaming: SSE event contract; commit point (no fallback after the first token) and why.
- Failure behaviour table: input → status/outcome (from tests).

## 4. Routing and fallback
- Rules in order (tenant policy → capability [tools only on Gemini ≥ 3] → priority), with the reason for each.
- Fallback triggers (TTFT timeout, total timeout, 429, 5xx, network) vs escalation (invalid output, intent disagreement).
- Why gemini-3.5-flash primary, gemini-3-flash fallback, mock last; the correlated-provider risk and how mock mitigates it.
- Observability: route_attempts, SSE route/attempt_failed events, request inspector screenshot.

## 5. Models and retrieval
- Model choices and the owner policy (Gemini 3+ Flash only; 2.5 excluded because of unreliable tool calling, with references).
- Thinking level choice (minimal default, low on escalation), backed by eval numbers.
- Retrieval: instruction-only embeddings, 768-d, pgvector exact scan (1,350 rows, no ANN needed), top-5, kNN intent weighted by dense cosine.
- Hybrid: dense + pg_trgm fused with RRF; **ranking separated from gating** (refusal always on calibrated dense cosine); lexical fallback when embedding fails. Retrieval-only eval (297 queries) table, the decision rule, and which mode became the default.
- Confidence and refusal: signals, decision table, calibrated thresholds (values + how they were calibrated on the dev split).
- Local profile: Ollama + nomic-embed-text; same code, different config.

## 6. Evaluation
- Data: 27 in-domain (1/intent, hard flags preferred) + 5 OOS; leakage caveat; n is small (1 case = 3.7 pp).
- Metrics and method (semantic similarity with a fixed scorer; LLM judge if done, with its bias caveat).
- Comparison table (paste from eval/report.md), then 3–5 sentences of interpretation and what changed because of it.
- Notable failure cases (2–3 examples).

## 7. Measurement accuracy
Where tokens come from (provider usage vs estimated for mock; an attempt that ends without the provider's usage after streaming content, e.g. an aborted Ollama stream whose usage only arrives in the final chunk, is metered as an estimate and flagged `tokens_estimated`, never as 0), thinking tokens billed as output, list-price-equivalent cost on the free tier, latency measured server-side (TTFT, total) and client-side in eval.

## 8. What I cut (and why)
(table from Part B)

## 9. Trade-offs accepted
(bullets from Part C)

## 9b. Technology choices
Short version of docs/11-tech-decisions.md §12 (the "not used" table), with a link to the full document.

## 10. What I would do next
3–5 bullets in priority order.
```

## Part B: "What I cut" log (Claude: keep this updated during the build; adjust to what actually happened)

| Cut | Why | What it would take |
|---|---|---|
| Per-minute rate limiting (only a token-budget quota) | The brief asks for a quota; rate limiting adds no new evidence of a correct request path | Token bucket in Postgres or Redis per tenant |
| Console login / RBAC (demo keys + admin key) | Not required; the console is a demo client | OAuth + per-user roles mapped to tenants |
| Multi-turn memory in the support assistant | Brief is single-message; keeps eval clean | Conversation table + summarisation window |
| Executing tools in the gateway (pass-through + capability routing only) | Tool execution belongs to product teams, not the router | Tool registry + sandboxed executors |
| OpenTelemetry / Langfuse / dashboards | DB metering + attempts table + request inspector already make decisions inspectable | OTel spans keyed by request_id, exporter |
| RAGAS / heavy eval frameworks | Python runtime + LLM judge cost; 32 cases are clearer with explicit metrics | — |
| ANN index on pgvector | 1,350 rows: exact scan is milliseconds | HNSW index when the KB grows |
| Cross-instance circuit breaker | Serverless instances don't share memory; per-request fallback already covers failures | Breaker state in Postgres/Redis |
| Response caching | Would distort latency and cost measurement | Semantic cache keyed by embedding |
| Charging embedding tokens to quota | Negligible cost; keeps the quota model simple | Add an embedding usage line to metering |
| In-memory circuit breaker (docs/04 §4 rule 4, P2) | Per-instance state only helps warm serverless instances; per-request fallback with TTFT/total timeouts already moves past a failing backend, and every skip would need its own attempt row | Breaker state in Postgres keyed by backend id, recorded as `skipped_circuit_open` |
| LLM-as-judge answer metric (docs/07 §3, P1) | First item of the cut order: it spends free-tier quota on every case and a Gemini judge would grade a Gemini answer (self-preference bias). Semantic similarity with one fixed scorer is kept | A judge from a different provider with a fixed rubric, run on a sample |
| Retrieval-only eval on `gemini-embedding-001` | The free tier allows 1,000 embedded texts per day per project; the quota went to the KB build | `pnpm eval:retrieval -- --provider gemini` on a fresh quota day |
| Full Docker mode A run on the owner's Mac | Pulls several GB into a Docker volume; the wiring was verified without the pull and mode B ran end to end | `docker compose --profile ollama up --build` |
| `@vercel/functions` (`waitUntil`, `attachDatabasePool`) | A new dependency needs a docs/11 row and owner approval, and the demo does not need it. If a client disconnects mid-answer on Vercel, that request's final metering write can be frozen before it completes; the connection pool is small (`max: 3`) | `waitUntil` around the final metering write, `attachDatabasePool(pool)` |
| Two Google AI Studio projects (`router-demo`, `router-eval`) | One Gemini key serves the local eval and the deployed demo, so they share the free-tier cap of 20 generation requests per day per model | Two keys in two Google projects (a separate key can be set in Vercel at any time) |

## Part C: Trade-offs to state explicitly

- **Single provider in the cloud** (two Gemini models + mock): zero cost and consistent quality. Correlated provider failures are mitigated only by mock.
- **Free-tier limits**: low RPM shapes the eval (sequential, with delays). Costs shown are list-price equivalents.
- **No fallback after the first token**: correctness over availability for partially streamed answers.
- **Refusal thresholds calibrated on a small dev set**: they will move with a different KB or embedding model; documented per model.
- **Hybrid retrieval**: adopted only if the retrieval eval shows a gain. Gating stays dense, so hybrid cannot improve OOS detection, only ranking. The lexical fallback trades accuracy for availability (confidence capped at medium).
- **Paraphrase-heavy dataset**: intent accuracy is optimistic, so we include hard-flag and OOS cases and report kNN vs LLM separately.
- **Demo keys visible in the SPA**: acceptable for a demo with low quotas; not for production.
- **Docker on macOS uses CPU for Ollama**: small default model in the container; native Ollama recommended for real use.

## Part D: Video demo script (target 6–8 minutes, 1280×800, deployed URL unless noted)

1. **(0:00) Intro, 30 s.** What the system is and the three things to watch: request path, routing/fallback, measurement.
2. **(0:30) Architecture, 45 s.** README diagram; one sentence per component.
3. **(1:15) Happy path, 60 s.** Playground, tenant `acme`, in-domain question with a typo. Show streaming, served-by, retrieved entries, intent (LLM vs kNN), confidence, tokens, TTFT, cost.
4. **(2:15) Fallback, 60 s.** Tick "force-fail gemini-3.5-flash" → FALLBACK badge, attempts timeline. Then force-fail both → served by MOCK with a grounded answer. Open the request inspector to show the recorded `route_attempts`.
5. **(3:15) Refusal, bad output and lexical fallback, 60 s.** Tick "embedding outage" → LEXICAL FALLBACK badge, still answers with medium confidence. OOS question → refusal without an LLM call (0 tokens). Prompt-injection attempt → refusal. Mention parser + escalation (show the unit test output briefly).
6. **(4:00) Tenant policy and quota, 60 s.** `globex` served only by allowed backends; `tiny` → run until 429 `quota_exceeded`; Usage page shows remaining quota and cost per tenant.
7. **(5:00) Terminal, 60 s.** `scripts/smoke.sh` against prod (all PASS); `curl -N` showing raw SSE; `pnpm -r test` summary.
8. **(6:00) Evaluation, 60 s.** `eval/report.md` comparison table; which config is the default and why.
9. **(7:00) Local mode, 30 s.** `docker compose --profile ollama up` already running; same console against Ollama.
10. **(7:30) Cuts and trade-offs, 30 s.** The "What I cut" table; close.

Record with `db:seed --reset-usage` done beforehand, after the 14:00 WIB free-tier reset. Type the admin key into
the console (Usage page) off camera before recording: the Usage, Requests and request-detail pages need it. Keep a
second take of the fallback segment in case of free-tier 429s.

## Part E: Submission checklist

- [x] Repo public/accessible, default branch clean, CI-free but `pnpm -r test` passes from a clean clone.
- [x] README has live URLs, demo keys (acme/globex/tiny), 3 ways to run, eval table, links to REPORT.md. *(video link pending)*
- [x] `docs/REPORT.md` complete with real numbers and the "What I cut" section.
- [x] `eval/results/*.json` + `eval/report.md` committed.
- [ ] Smoke test PASS on prod right before sending; quotas reset.
- [x] No secrets in git history. *(9 Oct: the only `AIza` matches are the checklist text itself; no key, no Neon password.)*
- [ ] Video plays logged-out.
- [ ] Reviewer can open the Usage page on the deployed console with the admin key from the email (`/admin/*` is read-only).

## Part F: Reply email draft (to the recruiter, same thread)

```
Subject: Re: Case Assignment Test — Muhammad Hasbi Ashshiddieqy

Dear [recruiter name],

Thank you for the opportunity. Please find my submission for the Mini Inference Router case below:

- Repository: <github url>
- Deployed console: <console url>   (gateway: <gateway url>)
- Technical report: <github url>/blob/main/docs/REPORT.md
- Video, technical walkthrough: https://docs.google.com/videos/d/12NTjikhjxePfBKm-jU_RCwF842gjO5h8RrHMXkl_zDk/play?usp=sharing
- Video, console demo: https://docs.google.com/videos/d/1OYfKRzPvsmi_xMfU-T_1Jfy9c8K-z1s4ZWvvghAQeT8/play?usp=sharing

Run instructions (cloud, Docker, or local Ollama) are in the README. Public demo keys are listed there.
A dedicated reviewer key with a larger quota: <reviewer key>
Admin key for the console's Usage and Requests pages (read-only endpoints): <admin key>
I'm happy to walk through the design or answer any questions.

Best regards,
Muhammad Hasbi Ashshiddieqy
```

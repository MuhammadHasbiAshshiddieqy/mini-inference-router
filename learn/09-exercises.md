# 09 · Hands-on exercises (≈ 50 min, more for the stretch goals)

Do them in order. The first four only *read and run*; the rest change code. Before you start: the local stack is
running (`docker compose up -d postgres`, migrated and seeded, `pnpm dev`), and you have the `acme` and `tiny`
keys (`SEED_KEY_ACME`, `SEED_KEY_TINY` in `.env`, or the keys printed by `pnpm db:seed`) and `ADMIN_API_KEY`.

After any code change, run `pnpm -r typecheck && pnpm -r lint && pnpm -r test`.

---

## 1. Trace one request (read-only, 10 min)

1. Send a support question with curl, `stream: false`. Note the `request_id` in the response.
2. In the gateway's terminal, find every log line with that id. In what order do `request start`, `admitted`,
   `attempt`, `settled`, `request end` appear?
3. Look the request up: `curl localhost:8787/admin/requests/<id> -H "authorization: Bearer $ADMIN_API_KEY"`.
4. For each log line, name the file that wrote it.

<details><summary>Hint</summary>

`http/request-id.ts` (start/end), `http/admission.ts` (`admitted`, `settled`), `router/execute.ts` (`attempt`).
</details>

## 2. Every way to be turned away (10 min)

Produce each of these responses with curl and write down the `error.code`:
no key, a wrong key, an empty `message`, `"max_output_tokens": 99999`, a body that is not JSON, a 70 KB body,
a `debug` option with the `globex` key.

Then find, for each one, the line of code that throws it (search for the code string, e.g. `"payload_too_large"`).

## 3. Watch the router fall back (10 min)

In the console playground with `acme`:

1. Tick **force-fail ollama** → which badges appear? What does the attempts timeline say?
2. Also tick **mock fails** → what is the outcome now? Which HTTP status would the JSON mode return?
3. Untick both, set **mock latency** to 12,000 ms and force-fail ollama → why does the mock attempt end with
   `timeout_ttft`? (Look for `MOCK_TTFT_TIMEOUT_MS` in `config/profiles.ts`.)

## 4. Run out of quota (10 min)

1. Send support questions with the `tiny` key until you get a 429. Read `error.details`.
2. Why does it fail although `remaining` is still above zero? Compute the reservation yourself:
   `estimateSupportPromptTokens(message, 5)` in `assistant/prompt.ts` + the tenant's `max_output_tokens`
   (`tiny` = 256).
3. Reset it: `pnpm db:seed -- --reset-usage`.

## 5. Move the refusal threshold (10 min)

1. Ask "Can you write me a poem about the sea?" → refused before the model (`low_retrieval_similarity`).
2. Restart the gateway with `CONFIDENCE_T_OOS=0.4 pnpm --filter gateway dev` and ask again. What happens now? Who
   refuses — the gate or the model (`model_out_of_scope`)? How many tokens did it cost this time?
3. Explain in one sentence why the threshold lives in `data/thresholds.json` and is calibrated on the dev split.

## 6. Add a log field (code change, 10 min)

In `assistant/answer.ts`, after retrieval, log the retrieval mode and the top-1 similarity at `info` level, e.g.
`log.info({ retrieval_mode: …, top1: … }, "retrieved")`. Send a question and find the new line. Make sure no
message text or key is logged (project rule).

## 7. Add a test (code change, 10 min)

Add a fixture to the parser tests in `assistant/assistant-pure.test.ts`: an answer whose header is written as
`Intent - cancel_order`. Decide first: should it be accepted or rejected? Write the test, run it, and check the
regular expression `HEADER_RE` in `assistant/parse.ts` to see why.

## 8. A console change (code change, 10 min)

Add a sixth example chip in `apps/console/src/pages/PlaygroundPage.vue` (the `EXAMPLES` array) with a question
for an intent you like. Check it in the browser, then run `pnpm --filter console typecheck`.

---

## Stretch goals

- **New refusal rule.** Today, after a failed escalation with *strong* evidence, the assistant refuses. Change the
  decision table so it answers with the kNN intent instead (the "what I would do next" idea in `docs/REPORT.md`).
  Update `decideOnHeader`, its tests in `assistant-pure.test.ts`, and `docs/05-support-assistant.md` §6.
- **A new debug option.** Add `debug.force_refusal` that makes the support assistant refuse with a new reason.
  You will touch `packages/shared/src/api.ts` (the option), `domain.ts` (the reason), `assistant/answer.ts`, the
  console's debug controls, and tests. This shows how one feature crosses all packages.
- **Read the spec against the code.** Pick one row of the traceability matrix in `docs/01-requirements.md`
  (e.g. R9 "fallback decision recorded and inspectable") and verify every claim in its "evidence" column.

Done? Skim the [glossary](10-glossary.md) and the [FAQ](11-faq.md) for anything still unclear.

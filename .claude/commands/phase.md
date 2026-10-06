---
description: Execute one phase of the Mini Inference Router plan (usage: /phase <0-12>)
argument-hint: <phase number 0-12>
---

You are executing **Phase $ARGUMENTS** of `docs/09-execution-plan.md` for the Mini Inference Router project.

## 0. Guard rails

- If `$ARGUMENTS` is empty or not a number from 0 to 12: print the phase list (number + title + checkbox status from `docs/09-execution-plan.md`), then stop.
- If any checkbox of an **earlier** phase is unticked: list the missing items and stop. Do not skip ahead.
- If the phase needs something only the owner can provide (API keys, Neon URL, Vercel access, Ollama models, AI Studio limits), list exactly what is needed and stop before writing code that depends on it.

## 1. Load context

Read `CLAUDE.md` fully. Then read every document listed under **Read:** for this phase in `docs/09-execution-plan.md`.
Always also skim:
- `docs/11-tech-decisions.md` before adding any dependency (no new dependency without a row there and owner approval);
- `docs/12-free-tier-limits-and-risks.md` for any phase touching Gemini, Neon, Vercel, Docker or Ollama.

## 2. Verify external facts first

Before hardcoding any external fact (model ID, SDK field name, price, rate limit, Vercel/Neon behaviour, Ollama flag),
check the official docs and add a code comment `// source: <url>, checked <YYYY-MM-DD>`.
If a fact differs from the docs in this repo, use the verified fact and update the doc in the same commit.

## 3. Plan, then implement

1. Write a short plan (files to create or change, tests to add) and show it.
2. Implement **only** what the phase specifies. If something extra seems necessary, or something specified is too costly:
   stop and propose it. For a cut, also propose the row for "What I cut" in `docs/10-report-and-demo.md`.
3. Respect the fixed decisions in `CLAUDE.md`: Gemini 3+ Flash only, ranking ≠ gating in retrieval, fail-closed quota,
   no fallback after the first token, metering written before `done`.

## 4. Verify

Run and **show the real output** of:

```
pnpm -r typecheck && pnpm -r lint && pnpm -r test
```

plus every **Verify** step of the phase (curl transcripts, SQL results, eval tables, screenshots saved to `docs/img/`).
Never weaken a test or a failure path to make it pass.

## 5. Close the phase

1. Tick the phase's checkboxes in `docs/09-execution-plan.md`.
2. Update any doc whose behaviour changed (and `docs/01-requirements.md` evidence column if relevant).
3. Commit with the phase's commit message (conventional commits).
4. **Stop** and report:
   - what was built (files);
   - verification evidence (command outputs, short);
   - deviations from the spec and why;
   - open risks or unknowns;
   - what the next phase needs from the owner.

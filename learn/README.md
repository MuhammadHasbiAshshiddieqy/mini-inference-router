# Learn this repository in one day

This folder is a guided path through the whole codebase for people who are **new to JavaScript/TypeScript**,
junior engineers, and anyone joining the project. You do not need to read the specs in `docs/` first; this guide
tells you when they are useful.

By the end of the day you should be able to:

- explain what the system does and which services it is made of;
- follow one request from the HTTP call to the database row, file by file;
- run the system, the tests and the evaluation on your laptop;
- change something small (a log line, a threshold, a new test) with confidence.

## How to use this guide

Read the files **in order**. Each one says how long it takes and which source files to open next to it.
Keep the code open in your editor while you read: the guide quotes small pieces, the files show the rest.
When a word is unfamiliar, look it up in the [glossary](10-glossary.md).

## The one-day plan

| Time | Read | Goal |
|---|---|---|
| 09:00 – 10:00 | [00 · JavaScript and TypeScript crash course](00-javascript-typescript-crash-course.md) | Read the syntax used in this repo without getting stuck |
| 10:00 – 10:30 | [01 · The big picture](01-big-picture.md) | What the system does; the services; one request end to end |
| 10:30 – 11:15 | [02 · Repository tour](02-repo-tour.md) | Monorepo, workspaces, **why there are several `node_modules`**, where everything lives |
| 11:15 – 12:00 | [03 · Tooling and commands](03-tooling-and-commands.md) | Run it: Node, pnpm, Docker, tests, env vars |
| 12:00 – 13:00 | _Lunch_ | |
| 13:00 – 15:30 | [04 · The gateway, step by step](04-gateway/README.md) (6 chapters) | The heart of the system: auth, quota, routing, streaming, the support assistant, the database |
| 15:30 – 16:00 | [05 · The shared package](05-shared-package.md) | The contracts both apps agree on |
| 16:00 – 16:40 | [06 · The console (Vue)](06-console.md) | How the browser app talks to the gateway |
| 16:40 – 17:10 | [07 · Scripts, data and evaluation](07-scripts-data-eval.md) | Where the data comes from and how quality is measured |
| 17:10 – 17:40 | [08 · Tests](08-tests.md) | How the code is tested; how to run one test |
| 17:40 – 18:30 | [09 · Hands-on exercises](09-exercises.md) | Prove to yourself that you understand it |
| any time | [10 · Glossary](10-glossary.md) · [11 · FAQ](11-faq.md) | Terms and "why is it like this?" questions |

If you only have **two hours**: read 01, 02, then chapters 01–03 of the gateway, then exercise 1.

## Where to start reading code

If you open only one file, open **[`apps/gateway/src/create-app.ts`](../apps/gateway/src/create-app.ts)**. It is
about 90 lines and wires every part of the server together in the order a request travels through it. Every
other file in the gateway is reachable from there. The reading order after that is in
[04-gateway/README.md](04-gateway/README.md).

## Before you start

You need: Node.js ≥ 22.18, pnpm, Docker Desktop, and (optional) Ollama. The [tooling chapter](03-tooling-and-commands.md)
explains each one. The quickest way to see the system working:

```bash
pnpm install
docker compose up -d postgres
pnpm db:migrate && pnpm db:seed && pnpm kb:embed -- --provider ollama --from-cache-only
pnpm -r test                    # 200+ tests, should all pass
```

## What this guide is not

It does not repeat the specs. When you want the full reasoning behind a decision, the guide links to the spec
(`docs/01` … `docs/12`) or to the technical report ([`docs/REPORT.md`](../docs/REPORT.md)).

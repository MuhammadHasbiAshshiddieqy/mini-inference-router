# 06 · The console (Vue) (≈ 40 min)

Folder: [`apps/console`](../apps/console). Package name: `@mir/console`. Screenshots: [`docs/img/`](../docs/img/).

The console is a single-page web app. It has **no special access**: it calls the same public API with a tenant
key, exactly like any product team would. That is a design choice — the gateway is the product, the console is
one of its clients.

## How it is built and served

- **Vite** runs a dev server (`pnpm --filter console dev`, port 5173) and builds the app into static files (`dist/`).
- **Vue 3** renders the pages; **Vue Router** maps URLs to pages; **Tailwind CSS** provides the styling through class names like `rounded border p-3`.
- In Docker the static files are served by **nginx**; on Vercel by Vercel. There is no Node server for the console.
- Settings come from `VITE_*` variables at **build time** ([`vite.config.ts`](../apps/console/vite.config.ts),
  [`src/lib/config.ts`](../apps/console/src/lib/config.ts)): the gateway URL and the list of public demo tenants.

## Reading order

| # | File | Why |
|---|---|---|
| 1 | [`src/main.ts`](../apps/console/src/main.ts) | Starts Vue and declares the 4 routes: `/playground`, `/usage`, `/requests`, `/requests/:id` |
| 2 | [`src/App.vue`](../apps/console/src/App.vue) | The top navigation; `<RouterView />` shows the current page |
| 3 | [`src/lib/api.ts`](../apps/console/src/lib/api.ts) | ★ How the browser calls the gateway, including streaming |
| 4 | [`src/lib/run-state.ts`](../apps/console/src/lib/run-state.ts) | ★ How events become what you see |
| 5 | [`src/pages/PlaygroundPage.vue`](../apps/console/src/pages/PlaygroundPage.vue) | The main page: controls, answer, `send()` |
| 6 | [`src/components/InspectorPanel.vue`](../apps/console/src/components/InspectorPanel.vue) | The right-hand panel: served by, attempts, intent, retrieval, metrics, raw events |
| 7 | [`src/components/AnswerText.vue`](../apps/console/src/components/AnswerText.vue) | Renders `{{Placeholders}}` as small grey chips |
| 8 | the other pages | Usage (auto-refresh every 10 s), the request list, the request detail with its attempts |

## Streaming in the browser: `lib/api.ts`

The browser's `EventSource` cannot send an `Authorization` header, so `streamEvents()` uses `fetch()` and reads
the body piece by piece:

```ts
const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, … }, body, signal });
if (!res.ok) throw await toApiError(res);          // 401/429/… arrive as normal JSON errors
const reader = res.body.getReader();
const parser = createSseParser((raw) => { … parseSseEvent(raw.event, JSON.parse(raw.data)) … onEvent(event) });
for (;;) { const { done, value } = await reader.read(); if (done) break; parser.push(decoder.decode(value, { stream: true })); }
```

The parser and the event schemas come from `@mir/shared` — the same ones the gateway used to send them. An
event that fails validation is ignored and logged to the browser console instead of crashing the page.
The **Stop** button aborts the `fetch` with an `AbortController`; the gateway sees the disconnect and stops the
model.

## From events to the screen: `lib/run-state.ts`

One run of the playground is a plain object (`RunState`: answer text, attempts, retrieval, intent, refusal,
errors, the `done` metrics, the raw event list). `applyEvent(state, event)` updates it for each event — a
**reducer**: given the current state and one event, produce the next state.

```
meta      → remember the request id
retrieval → the retrieved entries and kNN signals
route     → add an attempt row ("running")
attempt_failed → mark that row failed, with its error and latency
intent    → the intent and confidence
token     → append text
refusal / error → show the amber card / the red error
done      → metrics; mark the serving attempt "ok"
```

Because the page shows only what the events say, the inspector is an honest view of what the gateway did. In
`PlaygroundPage.vue` the state is wrapped with Vue's `reactive()`, so every change re-renders the page
automatically.

## The playground page in short

- **Tenant**: a dropdown of demo tenants, or "custom key" (kept in `sessionStorage`, i.e. only in this browser tab).
- **Mode**: support assistant (`/v1/support/answer`) or raw chat (`/v1/chat`).
- **Debug** controls appear only if `GET /v1/usage` says the tenant has `allow_debug`: force a backend to fail,
  make the mock fail, simulate an embedding outage, add mock latency. The backend list comes from `/healthz`.
- **Example chips** fill in typical questions (easy, typo, confusable, out of scope, injection).
- A **deep link** like `/playground?tenant=acme&q=…&force_fail=ollama&run=1` fills the form and sends — handy for
  demos and screenshots. It accepts demo tenant *names*, never keys.

## Keys and safety

- Public demo keys are compiled into the page on purpose (low quotas, resettable). The private reviewer key and
  the admin key are **never** bundled; they are typed into the page and kept in `sessionStorage`
  ([`lib/session.ts`](../apps/console/src/lib/session.ts), [`lib/admin-key.ts`](../apps/console/src/lib/admin-key.ts)).
- Storage access is wrapped in `try/catch` because private browsing can block it; the page still works without it.

## Try it

`pnpm dev`, open http://localhost:5173, send the "confusable" example, open **Raw events** at the bottom of the
inspector, and match each event to a line of `applyEvent`. Then tick "force-fail …" and watch the FALLBACK badge
and the attempts timeline. Finally open "Open request …" (needs the admin key) to see the same story from the
database.

Next: [07 · Scripts, data and evaluation](07-scripts-data-eval.md).

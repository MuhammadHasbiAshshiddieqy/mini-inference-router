# Gateway 02 · Auth, quota and metering (≈ 30 min)

Files: `http/body.ts`, `http/auth.ts`, `http/api-keys.ts`, `http/admission.ts`, `quota/quota.ts`,
`metering/requests.ts`, `metering/attempts.ts`, `metering/usage.ts`, `config/pricing.ts`, `routes/usage.ts`,
`routes/admin.ts`.

This chapter answers the brief's first three requirements: **authenticate** each tenant, **enforce a quota that
fails closed**, and **record** what each request did and cost.

## Before auth: size and type

[`http/body.ts`](../../apps/gateway/src/http/body.ts) rejects bodies over 64 KB (413) and non-JSON bodies (415).
These run *before* auth, so a huge or malformed request is rejected without a database lookup.

## Tenant authentication

[`http/auth.ts`](../../apps/gateway/src/http/auth.ts) → `tenantAuth(getPool)`:

1. Read the key from `Authorization: Bearer <key>` or `x-api-key`. None → **401 `missing_api_key`**.
2. Hash it with SHA-256 ([`http/api-keys.ts`](../../apps/gateway/src/http/api-keys.ts)) and look up `tenants.api_key_hash`.
   The database stores only hashes, so a leaked database does not leak keys.
3. Not found → **401 `invalid_api_key`**. Disabled → **403 `tenant_disabled`**.
4. Database unreachable → **503 `quota_unavailable`**. This is "failing closed": when we cannot check, we refuse.
5. Store the tenant on the context (`c.set("tenant", …)`) for the route.

Why SHA-256 and not bcrypt? API keys are long random strings, not human passwords, so a fast hash is safe and
keeps every request quick ([`docs/11`](../../docs/11-tech-decisions.md) §2).

`adminAuth` (same file) compares the admin key in *constant time* (`timingSafeEqual`), so an attacker cannot
guess it byte by byte from response times.

## Admission: everything before the work starts

[`http/admission.ts`](../../apps/gateway/src/http/admission.ts) → `admit(c, options)` is shared by `/v1/chat` and
`/v1/support/answer`. Read it top to bottom; it is the request path in miniature:

```
parse JSON + Zod schema ─► tenant policy (max_output_tokens cap, debug allowed?) ─► precheck (routing plan)
   │ any problem: 400/403/422, and ONE `requests` row with outcome invalid_request
   ▼
reserve tokens ─► not enough: 429 + a `requests` row (quota_exceeded) │ DB down: 503, no row possible
   ▼
insert the `requests` row with outcome "in_progress"   (so a crash midway still leaves a trace)
   ▼
return { tenant, body, reservedTokens, quota, startedAt, … }   → the route does its work
```

Why validation *after* auth? The output cap depends on the tenant, and the project rule is "every request from a
known tenant produces exactly one `requests` row" — impossible before we know the tenant.

At the end of the route, `settle(db, c, admission, final)` does the opposite: reconcile the quota, compute
latency, and finalize the row (outcome, backend, tokens, cost, TTFT…). It runs **before** the final `done` event
is sent, because on Vercel work after the response may be frozen.

## The quota: one SQL statement

[`quota/quota.ts`](../../apps/gateway/src/quota/quota.ts). The budget is in **tokens**.
`used_tokens` counts tokens consumed *plus* tokens currently reserved by requests in flight.

```sql
UPDATE tenants SET used_tokens = used_tokens + $2
WHERE id = $1 AND enabled AND used_tokens + $2 <= quota_tokens
RETURNING quota_tokens, used_tokens
```

This is the most important line in the gateway. The check (`used + reserve <= quota`) and the increment happen
in **one** statement, so the database guarantees two concurrent requests cannot both pass a check that only one
should pass. If no row comes back, there was not enough budget → **429 `quota_exceeded`** with
`{ limit, used, remaining, requested }`. A test fires 15 requests in parallel at a quota that fits exactly 5:
exactly 5 succeed (`request-path.test.ts`).

How much to reserve? `estimate of the prompt (≈ characters / 4) + max_output_tokens`. After the request,
`reconcileTokens` replaces the estimate with the real number:

```sql
UPDATE tenants SET used_tokens = GREATEST(0, used_tokens - $2 + $3)   -- minus reserved, plus actual
```

If that update fails, the reservation is kept (we never give tokens back when we are unsure). Failed attempts
that used tokens are still charged: the actual number is the sum over *all* attempts.

## Metering: what gets written

[`metering/requests.ts`](../../apps/gateway/src/metering/requests.ts) writes the rows; the columns are described
in [chapter 06](06-database.md).

| Function | When |
|---|---|
| `recordRejectedRequest` | validation or quota rejection (one final row) |
| `insertRequest` | admission succeeded (`in_progress`) |
| `insertAttempt` (via `metering/attempts.ts`) | after **each** backend attempt, success or failure |
| `finalizeRequest` | in `settle`, before `done` |

## Cost: exact money maths

[`config/pricing.ts`](../../apps/gateway/src/config/pricing.ts). Prices are in USD per million tokens, kept as
**strings** (`"1.50"`), and the cost is computed with integers (`BigInt`) in units of 0.00000001 USD:

```
cost = (prompt × input_price + (completion + thinking) × output_price) / 1,000,000
```

Why not plain numbers? Floating point cannot represent decimals exactly: `0.1 + 0.2` is
`0.30000000000000004` in JavaScript. Summing many small costs that way drifts. The database column is
`numeric(12,8)` for the same reason. Thinking tokens (Gemini's internal reasoning) are billed as output.
Read `pricing.test.ts`: it tests exactly these cases. Costs are "list-price equivalents" because the project
runs on free tiers.

## Reading it back: `/v1/usage` and `/admin/*`

[`metering/usage.ts`](../../apps/gateway/src/metering/usage.ts) holds the read queries (totals per tenant,
outcome counts, recent requests, one request with its attempts). [`routes/usage.ts`](../../apps/gateway/src/routes/usage.ts)
and [`routes/admin.ts`](../../apps/gateway/src/routes/admin.ts) only validate input and call them. The response
shapes are Zod schemas in `packages/shared/src/api.ts`, which the console uses to check what it receives.

## Try it

```bash
curl localhost:8787/v1/usage -H "authorization: Bearer $SEED_KEY_ACME"           # your quota and policy
for i in 1 2 3 4; do curl -s localhost:8787/v1/support/answer -H "authorization: Bearer $SEED_KEY_TINY" \
  -H "content-type: application/json" -d '{"message":"cancel my order","stream":false}' | head -c 120; echo; done
# the 'tiny' tenant runs out quickly → 429 quota_exceeded with limit/used/remaining/requested
```

Next: [03 · Backends and the router](03-backends-and-router.md).

# Gateway 06 · The database (≈ 15 min)

Files: `db/schema.ts`, `db/client.ts`, `db/migrate.ts`, `db/migrations/*.sql`, `test-support/db.ts`,
`scripts/migrate.ts`, `scripts/seed.ts`.

## Four tables

Defined in [`db/schema.ts`](../../apps/gateway/src/db/schema.ts) with **Drizzle ORM** (TypeScript that describes
tables). Full column list: [`docs/03-architecture.md`](../../docs/03-architecture.md) §6.

| Table | One row per | Key columns |
|---|---|---|
| `tenants` | customer (acme, globex, tiny, eval, reviewer) | `api_key_hash`, `quota_tokens`, `used_tokens`, `allowed_backends`, `max_output_tokens`, `allow_debug`, `enabled` |
| `requests` | request from a known tenant | `id` (= request id), `outcome`, `served_backend_id`, `fallback_fired`, `escalated`, tokens, `cost_usd`, `latency_ms`, `ttft_ms`, `intent`, `confidence_level`, `retrieved_ids`, `retrieval_mode`, `error_code` |
| `route_attempts` | backend attempt (many per request) | `request_id`, `attempt_no`, `backend_id`, `reason` (primary / fallback:… / escalation:…), `status`, `error_detail`, tokens, cost, latency |
| `kb_entries` | knowledge-base entry per embedding model | `id`, `embedding_model`, `intent`, `instruction`, `response`, `instruction_norm`, `embedding vector(768)` |

`requests` + `route_attempts` are the **metering** the brief asks for and the "recorded and inspectable"
fallback decisions. Money is `numeric(12,8)` (exact decimals, never floating point).

## From schema to tables: migrations

1. You edit `db/schema.ts`.
2. `pnpm --filter gateway db:generate` (drizzle-kit) writes a new SQL file into `db/migrations/` plus a snapshot in `meta/`.
3. `pnpm db:migrate` ([`scripts/migrate.ts`](../../scripts/migrate.ts) → [`db/migrate.ts`](../../apps/gateway/src/db/migrate.ts)) applies the files that have not run yet, in order. Drizzle remembers which ones ran, so running it twice is safe.

There are two migrations: `0000_extensions.sql` is hand-written (`CREATE EXTENSION vector` and `pg_trgm`;
drizzle-kit does not manage extensions), `0001_init.sql` is generated (the four tables and their indexes).

## How queries are written

Drizzle defines the schema and runs the migrations. The queries themselves are mostly **plain SQL** with
parameters, sent through the `pg` driver's pool:

```ts
await db.query(`UPDATE tenants SET used_tokens = used_tokens + $2 WHERE id = $1 AND … RETURNING …`, [tenantId, tokens]);
```

`$1`, `$2` are **placeholders**: values are sent separately from the SQL text, so user input can never change
the query (no SQL injection). Raw SQL is used on purpose where precision matters (the atomic quota update, the
hybrid retrieval query) and because it is easy for reviewers to read. Functions take a small `Queryable` type
(anything with a `query` method), which lets tests pass a fake that fails on purpose ("the database is down").

## The connection pool

[`db/client.ts`](../../apps/gateway/src/db/client.ts) → `createDb()` makes a `pg.Pool` with **at most 3
connections**, a 5 s idle timeout, and connect/query timeouts from `DB_TIMEOUT_MS` (8 s: long enough for the free
Neon database to wake up from sleep). `lazyDb()` creates it on first use only. On Vercel many short-lived
instances can run at once, so each keeps very few connections; Neon's *pooled* connection string does the real
pooling.

## Seeding

[`scripts/seed.ts`](../../scripts/seed.ts) creates or updates the five demo tenants (their quotas, allowed
backends, debug permission). Keys: if `SEED_KEY_<TENANT>` is set it is hashed and stored; otherwise a key is
generated *only for a tenant that does not exist yet* and printed once. Existing keys are never silently
replaced. `--reset-usage` sets `used_tokens` back to 0 (before a demo).

The knowledge base is loaded by `pnpm kb:embed` (chapter [07](../07-scripts-data-eval.md)).

## The test database

Tests that need Postgres use a separate database, `router_test`, on the same server
([`test-support/db.ts`](../../apps/gateway/src/test-support/db.ts)): it is created and migrated automatically,
and tables are emptied before each test. If Postgres is not running, those tests are **skipped with a visible
warning** (so a fresh clone can still run the other tests); `REQUIRE_DB=1` turns that into a failure. Test files
run one at a time in the gateway (`vitest.config.ts`) because they share this database.

You have finished the gateway. Next: [05 · The shared package](../05-shared-package.md).

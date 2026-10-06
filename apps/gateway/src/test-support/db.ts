import pg from "pg";
import { createDb, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { generateApiKey, hashApiKey, apiKeyPrefix } from "../http/api-keys.ts";

// Integration tests run against a dedicated database (`router_test`) on the local Postgres from docker-compose.
// It is created and migrated on first use; tables are truncated between tests (kb_entries is left alone).
//
// When Postgres is not running, DB tests are SKIPPED with a visible warning, so `pnpm -r test` still works
// from a clean clone. Set REQUIRE_DB=1 to turn an unreachable database into a test failure instead.

export const TEST_DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432/router_test";

async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const dbName = target.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(dbName)) throw new Error(`unsafe test database name: ${dbName}`);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString(), connectionTimeoutMillis: 2000 });
  await client.connect();
  try {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await client.end();
  }
}

let handle: DbHandle | undefined;

export async function connectTestDb(): Promise<DbHandle | undefined> {
  if (handle) return handle;
  try {
    await ensureDatabase(TEST_DATABASE_URL);
    handle = createDb({ databaseUrl: TEST_DATABASE_URL, timeoutMs: 5000 });
    await runMigrations(handle.db);
    return handle;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (process.env["REQUIRE_DB"] === "1") throw new Error(`test database unavailable: ${reason}`, { cause: err });
    process.stderr.write(
      `\n⚠ Skipping database tests: ${TEST_DATABASE_URL} unreachable (${reason}).\n` +
        "  Start it with `docker compose up -d postgres`, or set REQUIRE_DB=1 to fail instead.\n",
    );
    return undefined;
  }
}

export async function resetTestDb(db: DbHandle): Promise<void> {
  await db.pool.query("TRUNCATE route_attempts, requests, tenants RESTART IDENTITY CASCADE");
}

export type TestTenant = { id: string; key: string };

export async function createTestTenant(
  db: DbHandle,
  overrides: Partial<{
    id: string;
    quotaTokens: number;
    usedTokens: number;
    allowedBackends: string[];
    maxOutputTokens: number;
    allowDebug: boolean;
    enabled: boolean;
  }> = {},
): Promise<TestTenant> {
  const t = {
    id: "acme",
    quotaTokens: 100_000,
    usedTokens: 0,
    allowedBackends: ["gemini-3.5-flash", "gemini-3-flash", "ollama", "mock"],
    maxOutputTokens: 1024,
    allowDebug: true,
    enabled: true,
    ...overrides,
  };
  const key = generateApiKey();
  await db.pool.query(
    `INSERT INTO tenants (id, name, api_key_hash, api_key_prefix, quota_tokens, used_tokens, allowed_backends,
       max_output_tokens, allow_debug, enabled)
     VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      t.id,
      hashApiKey(key),
      apiKeyPrefix(key),
      t.quotaTokens,
      t.usedTokens,
      t.allowedBackends,
      t.maxOutputTokens,
      t.allowDebug,
      t.enabled,
    ],
  );
  return { id: t.id, key };
}

export async function usedTokens(db: DbHandle, tenantId: string): Promise<number> {
  const { rows } = await db.pool.query<{ used: string }>("SELECT used_tokens AS used FROM tenants WHERE id = $1", [
    tenantId,
  ]);
  return Number(rows[0]?.used);
}

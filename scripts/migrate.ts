// pnpm db:migrate — applies SQL migrations from apps/gateway/src/db/migrations (idempotent).
import { createDb } from "../apps/gateway/src/db/client.ts";
import { MIGRATIONS_FOLDER, runMigrations } from "../apps/gateway/src/db/migrate.ts";
import { databaseEnv, describeDatabase, fail, parseScriptEnv } from "./lib/cli.ts";

const env = parseScriptEnv(databaseEnv);
const { db, pool } = createDb({ databaseUrl: env.DATABASE_URL, timeoutMs: env.DB_TIMEOUT_MS });

try {
  console.log(`Migrating ${describeDatabase(env.DATABASE_URL)} from ${MIGRATIONS_FOLDER}`);
  await runMigrations(db);
  const { rows } = await pool.query<{ extname: string; extversion: string }>(
    "SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector', 'pg_trgm') ORDER BY extname",
  );
  console.log(`✓ migrations applied; extensions: ${rows.map((r) => `${r.extname} ${r.extversion}`).join(", ")}`);
} catch (err) {
  fail(`migration failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await pool.end();
}

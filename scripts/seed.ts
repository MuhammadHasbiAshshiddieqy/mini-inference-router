// pnpm db:seed [-- --reset-usage] [--with-eval]
// Idempotent upsert of the demo tenants (docs/03 §9). Keys:
//   - SEED_KEY_<TENANT> set   → that key is (re)hashed and stored, so local and cloud keys can be pinned.
//   - not set, tenant missing → a key is generated, stored as a hash, and printed ONCE.
//   - not set, tenant exists  → the existing key is kept (policy fields are still updated).
import { BACKEND_IDS, ProfileSchema, type BackendId } from "@mir/shared";
import { z } from "zod";
import { MIN_API_KEY_LENGTH, apiKeyPrefix, generateApiKey, hashApiKey } from "../apps/gateway/src/http/api-keys.ts";
import { createDb } from "../apps/gateway/src/db/client.ts";
import { databaseEnv, describeDatabase, fail, parseCliArgs, parseScriptEnv } from "./lib/cli.ts";

type TenantSeed = {
  id: string;
  name: string;
  allowedBackends: readonly BackendId[];
  quotaTokens: number;
  maxOutputTokens: number;
  allowDebug: boolean;
};

const ALL = BACKEND_IDS;

const TENANTS: readonly TenantSeed[] = [
  {
    id: "acme",
    name: "Acme (public demo, debug)",
    allowedBackends: ALL,
    quotaTokens: 150_000,
    maxOutputTokens: 1024,
    allowDebug: true,
  },
  {
    id: "globex",
    name: "Globex (restricted policy)",
    allowedBackends: ["gemini-3-flash", "mock"],
    quotaTokens: 50_000,
    maxOutputTokens: 512,
    allowDebug: false,
  },
  {
    id: "tiny",
    name: "Tiny (low quota)",
    allowedBackends: ALL,
    quotaTokens: 3_000,
    maxOutputTokens: 256,
    allowDebug: false,
  },
  {
    id: "eval",
    name: "Eval runner",
    allowedBackends: ALL,
    quotaTokens: 2_000_000,
    maxOutputTokens: 1024,
    allowDebug: true,
  },
  {
    id: "reviewer",
    name: "Reviewer (private key)",
    allowedBackends: ALL,
    quotaTokens: 500_000,
    maxOutputTokens: 1024,
    allowDebug: true,
  },
];

const seedKey = z.string().min(MIN_API_KEY_LENGTH, `must be at least ${MIN_API_KEY_LENGTH} characters`).optional();
const env = parseScriptEnv({
  ...databaseEnv,
  PROFILE: ProfileSchema.default("local"),
  SEED_KEY_ACME: seedKey,
  SEED_KEY_GLOBEX: seedKey,
  SEED_KEY_TINY: seedKey,
  SEED_KEY_EVAL: seedKey,
  SEED_KEY_REVIEWER: seedKey,
});
const args = parseCliArgs({
  "reset-usage": { type: "boolean", default: false },
  "with-eval": { type: "boolean", default: false },
});

function pinnedKey(tenantId: string): string | undefined {
  return env[`SEED_KEY_${tenantId.toUpperCase()}` as keyof typeof env] as string | undefined;
}

// The eval tenant is for local/eval runs; it is not created on the cloud DB unless asked (docs/03 §9).
const tenants = TENANTS.filter((t) => t.id !== "eval" || env.PROFILE !== "cloud" || args["with-eval"]);
const { pool } = createDb({ databaseUrl: env.DATABASE_URL, timeoutMs: env.DB_TIMEOUT_MS });
const generated: { id: string; key: string }[] = [];

try {
  console.log(`Seeding ${tenants.length} tenants into ${describeDatabase(env.DATABASE_URL)} (PROFILE=${env.PROFILE})`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const t of tenants) {
      const exists = (await client.query("SELECT 1 FROM tenants WHERE id = $1", [t.id])).rowCount === 1;
      const pinned = pinnedKey(t.id);
      const key = pinned ?? (exists ? undefined : generateApiKey());
      if (key && !pinned) generated.push({ id: t.id, key });

      const policy = [t.name, t.quotaTokens, [...t.allowedBackends], t.maxOutputTokens, t.allowDebug];
      if (key) {
        await client.query(
          `INSERT INTO tenants (id, name, quota_tokens, allowed_backends, max_output_tokens, allow_debug, api_key_hash, api_key_prefix)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET name = $2, quota_tokens = $3, allowed_backends = $4, max_output_tokens = $5,
             allow_debug = $6, api_key_hash = $7, api_key_prefix = $8, enabled = true`,
          [t.id, ...policy, hashApiKey(key), apiKeyPrefix(key)],
        );
      } else {
        await client.query(
          `UPDATE tenants SET name = $2, quota_tokens = $3, allowed_backends = $4, max_output_tokens = $5,
             allow_debug = $6, enabled = true WHERE id = $1`,
          [t.id, ...policy],
        );
      }
      const keyNote = pinned ? "key from SEED_KEY" : key ? "key generated" : "existing key kept";
      console.log(`  ${exists ? "updated" : "created"} ${t.id.padEnd(9)} ${keyNote}`);
    }
    if (args["reset-usage"]) {
      const res = await client.query("UPDATE tenants SET used_tokens = 0 WHERE id = ANY($1)", [
        tenants.map((t) => t.id),
      ]);
      console.log(`  reset used_tokens for ${res.rowCount} tenants`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const { rows } = await pool.query<{ id: string; prefix: string; quota: string; used: string; backends: string[] }>(
    `SELECT id, api_key_prefix AS prefix, quota_tokens AS quota, used_tokens AS used, allowed_backends AS backends
     FROM tenants ORDER BY id`,
  );
  console.log("\n  tenant     key prefix  quota      used   allowed_backends");
  for (const r of rows) {
    console.log(
      `  ${r.id.padEnd(10)} ${r.prefix.padEnd(11)} ${r.quota.padStart(9)} ${r.used.padStart(6)}   ${r.backends.join(",")}`,
    );
  }

  if (generated.length > 0) {
    console.log("\nGenerated API keys (shown once; only their SHA-256 hashes are stored).");
    console.log("Copy them into .env as SEED_KEY_<TENANT> to keep them stable across re-seeds:\n");
    for (const { id, key } of generated) console.log(`  SEED_KEY_${id.toUpperCase()}=${key}`);
  }
} catch (err) {
  fail(`seed failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await pool.end();
}

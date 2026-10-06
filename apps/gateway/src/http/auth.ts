import { createHash, timingSafeEqual } from "node:crypto";
import { BackendIdSchema } from "@mir/shared";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { Pool } from "pg";
import { hashApiKey } from "./api-keys.ts";
import { AppError } from "./errors.ts";
import type { AppEnv, Tenant } from "./types.ts";

// `Authorization: Bearer <key>` or `x-api-key: <key>` (docs/03 §2 step 3).
function presentedKey(c: Context<AppEnv>): string | undefined {
  const auth = c.req.header("authorization");
  if (auth) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    return match?.[1];
  }
  return c.req.header("x-api-key")?.trim() || undefined;
}

type TenantRow = {
  id: string;
  name: string;
  quota_tokens: string;
  used_tokens: string;
  allowed_backends: string[];
  max_output_tokens: number;
  allow_debug: boolean;
  enabled: boolean;
};

function toTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    quotaTokens: Number(row.quota_tokens),
    usedTokens: Number(row.used_tokens),
    // Unknown ids in the DB are dropped rather than trusted: policy can only narrow, never widen.
    allowedBackends: row.allowed_backends.flatMap((id) => {
      const parsed = BackendIdSchema.safeParse(id);
      return parsed.success ? [parsed.data] : [];
    }),
    maxOutputTokens: row.max_output_tokens,
    allowDebug: row.allow_debug,
  };
}

// Tenant auth for /v1/*. The key is hashed and looked up; the raw key is never logged or stored.
// If the tenant store is unreachable we fail closed with 503 (same code as the quota store: one database).
export function tenantAuth(getPool: () => Pool) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const key = presentedKey(c);
    if (!key) throw new AppError("missing_api_key", 401, "Missing API key (Authorization: Bearer <key> or x-api-key)");

    let row: TenantRow | undefined;
    try {
      const result = await getPool().query<TenantRow>(
        `SELECT id, name, quota_tokens, used_tokens, allowed_backends, max_output_tokens, allow_debug, enabled
         FROM tenants WHERE api_key_hash = $1`,
        [hashApiKey(key)],
      );
      row = result.rows[0];
    } catch (err) {
      c.get("logger").error({ err }, "tenant lookup failed");
      throw new AppError(
        "quota_unavailable",
        503,
        "Tenant and quota store unavailable; request rejected (fail closed)",
      );
    }
    if (!row) throw new AppError("invalid_api_key", 401, "Invalid API key");
    if (!row.enabled) throw new AppError("tenant_disabled", 403, `Tenant ${row.id} is disabled`);

    const tenant = toTenant(row);
    c.set("tenant", tenant);
    c.set("logger", c.get("logger").child({ tenant_id: tenant.id }));
    await next();
  });
}

export function requireTenant(c: Context<AppEnv>): Tenant {
  const tenant = c.get("tenant");
  if (!tenant) throw new AppError("internal_error", 500, "Tenant auth middleware did not run");
  return tenant;
}

// Admin auth for /admin/*: `Authorization: Bearer <ADMIN_API_KEY>`, compared in constant time.
export function adminAuth(adminApiKey: string) {
  const expected = createHash("sha256").update(adminApiKey).digest();
  return createMiddleware<AppEnv>(async (c, next) => {
    const key = presentedKey(c);
    if (!key) throw new AppError("missing_api_key", 401, "Missing admin key (Authorization: Bearer <ADMIN_API_KEY>)");
    const actual = createHash("sha256").update(key).digest();
    if (!timingSafeEqual(actual, expected)) throw new AppError("invalid_api_key", 401, "Invalid admin key");
    await next();
  });
}

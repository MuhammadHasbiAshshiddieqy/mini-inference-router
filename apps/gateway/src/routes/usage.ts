import type { UsageResponse } from "@mir/shared";
import { Hono } from "hono";
import type { Pool } from "pg";
import { requireTenant } from "../http/auth.ts";
import { AppError } from "../http/errors.ts";
import type { AppEnv } from "../http/types.ts";
import { tenantUsage } from "../metering/usage.ts";

// GET /v1/usage — the calling tenant's usage, remaining quota and policy (the console reads `allow_debug` here).
export function usageRoutes(getPool: () => Pool) {
  return new Hono<AppEnv>().get("/usage", async (c) => {
    const tenant = requireTenant(c);
    const [view] = await tenantUsage(getPool(), tenant.id);
    if (!view) throw new AppError("invalid_api_key", 401, "Tenant no longer exists");
    const body: UsageResponse = {
      tenant: { id: view.id, name: view.name },
      quota: view.quota,
      policy: {
        allowed_backends: tenant.allowedBackends,
        allow_debug: tenant.allowDebug,
        max_output_tokens: tenant.maxOutputTokens,
      },
      usage: view.usage,
    };
    return c.json(body);
  });
}

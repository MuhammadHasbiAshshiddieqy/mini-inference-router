import { Hono } from "hono";
import type { Pool } from "pg";
import type { Logger } from "pino";
import type { Env } from "./config/env.ts";
import { adminAuth, tenantAuth } from "./http/auth.ts";
import { limitBody, requireJson } from "./http/body.ts";
import { errorHandler, notFoundHandler } from "./http/error-handler.ts";
import { requestContext } from "./http/request-id.ts";
import type { AppEnv } from "./http/types.ts";
import { adminRoutes } from "./routes/admin.ts";
import { healthRoutes } from "./routes/health.ts";
import { usageRoutes } from "./routes/usage.ts";

export type AppDeps = {
  env: Env;
  logger: Logger;
  getPool: () => Pool; // lazy: the pool is created on first use
};

// Builds the Hono app. Kept separate from index.ts (Vercel entry) and local.ts (Node server) so tests
// can build it with their own env, logger and database. Not named app.ts/server.ts: Vercel scans those names.
//
// Order on /v1/*: request id → body size (413) → JSON content type (415) → tenant auth (401/403/503)
// → route: body validation + policy (400/403) → quota reservation (429/503) → work → metering.
export function createApp({ env, logger, getPool }: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use(requestContext(logger));
  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  app.route("/", healthRoutes(env));

  app.use("/v1/*", limitBody, requireJson, tenantAuth(getPool));
  app.route("/v1", usageRoutes(getPool));

  app.use("/admin/*", adminAuth(env.ADMIN_API_KEY));
  app.route("/admin", adminRoutes(getPool));

  return app;
}

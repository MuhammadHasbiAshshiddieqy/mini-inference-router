import { Hono } from "hono";
import type { Logger } from "pino";
import type { Env } from "./config/env.ts";
import { errorHandler, notFoundHandler } from "./http/error-handler.ts";
import { requestContext } from "./http/request-id.ts";
import type { AppEnv } from "./http/types.ts";
import { healthRoutes } from "./routes/health.ts";

export type AppDeps = {
  env: Env;
  logger: Logger;
};

// Builds the Hono app. Kept separate from index.ts (Vercel entry) and local.ts (Node server) so tests
// can build it with their own env and logger. Not named app.ts/server.ts: Vercel scans those names as entries.
export function createApp({ env, logger }: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use(requestContext(logger));
  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  app.route("/", healthRoutes(env));

  return app;
}

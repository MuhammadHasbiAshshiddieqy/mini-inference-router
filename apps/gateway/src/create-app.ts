import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Pool } from "pg";
import type { Logger } from "pino";
import { checkAssistantReadiness, type AssistantReadiness } from "./assistant/readiness.ts";
import { createBackendRegistry, type BackendRegistry } from "./backends/registry.ts";
import { embeddingModelFor, type Env } from "./config/env.ts";
import { resolveThresholds, type ThresholdsResult } from "./config/thresholds.ts";
import { createQueryEmbedder } from "./embeddings/registry.ts";
import type { Embedder } from "./embeddings/types.ts";
import { adminAuth, tenantAuth } from "./http/auth.ts";
import { limitBody, requireJson } from "./http/body.ts";
import { errorHandler, notFoundHandler } from "./http/error-handler.ts";
import { requestContext } from "./http/request-id.ts";
import type { AppEnv } from "./http/types.ts";
import { adminRoutes } from "./routes/admin.ts";
import { chatRoutes } from "./routes/chat.ts";
import { supportRoutes } from "./routes/support.ts";
import { healthRoutes, type OllamaProbe } from "./routes/health.ts";
import { usageRoutes } from "./routes/usage.ts";

export type AppDeps = {
  env: Env;
  logger: Logger;
  getPool: () => Pool; // lazy: the pool is created on first use
  registry?: BackendRegistry; // defaults to the active profile's backends from env
  probeOllama?: OllamaProbe; // injectable for tests
  waitUntil?: (promise: Promise<unknown>) => void; // Vercel: keep metering writes alive after the response
  heartbeatMs?: number; // SSE heartbeat interval (tests use a short one)
  embedder?: Embedder; // query embedder; defaults to the active profile's
  thresholds?: ThresholdsResult; // defaults to data/thresholds.json + CONFIDENCE_* overrides
  checkAssistant?: () => Promise<AssistantReadiness>; // injectable for tests
};

// Builds the Hono app. Kept separate from index.ts (Vercel entry) and local.ts (Node server) so tests
// can build it with their own env, logger and database. Not named app.ts/server.ts: Vercel scans those names.
//
// Order on /v1/*: request id → body size (413) → JSON content type (415) → tenant auth (401/403/503)
// → route: body validation + policy (400/403) → quota reservation (429/503) → work → metering.
export function createApp({
  env,
  logger,
  getPool,
  registry = createBackendRegistry(env),
  probeOllama,
  waitUntil,
  heartbeatMs,
  embedder = createQueryEmbedder(env),
  thresholds = resolveThresholds(env, embeddingModelFor(env)),
  checkAssistant,
}: AppDeps) {
  const embeddingModel = embeddingModelFor(env);
  const extras = { ...(waitUntil ? { waitUntil } : {}), ...(heartbeatMs ? { heartbeatMs } : {}) };
  const app = new Hono<AppEnv>();
  app.use(requestContext(logger));
  // The console is a browser client on another origin (docs/06). Preflights are answered here, before auth.
  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["authorization", "content-type", "x-api-key"],
      exposeHeaders: ["x-request-id"],
      maxAge: 600,
    }),
  );
  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  app.route(
    "/",
    healthRoutes(
      env,
      registry,
      checkAssistant ?? (() => checkAssistantReadiness(getPool(), embeddingModel, thresholds)),
      probeOllama,
      thresholds,
    ),
  );

  app.use("/v1/*", limitBody, requireJson, tenantAuth(getPool));
  app.route("/v1", usageRoutes(getPool));
  app.route("/v1", chatRoutes({ env, getPool, registry, ...extras }));
  app.route("/v1", supportRoutes({ env, getPool, registry, embedder, embeddingModel, thresholds, ...extras }));

  app.use("/admin/*", adminAuth(env.ADMIN_API_KEY));
  app.route("/admin", adminRoutes(getPool));

  return app;
}

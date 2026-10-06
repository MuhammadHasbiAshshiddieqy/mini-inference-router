import { loadEnv } from "./config/env.ts";
import { createApp } from "./create-app.ts";
import { lazyDb } from "./db/client.ts";
import { createLogger } from "./logger.ts";

// Vercel entry (zero-config Hono): the default export is the app.
export const env = loadEnv(process.env);
export const logger = createLogger(env.LOG_LEVEL);

const getDb = lazyDb({
  databaseUrl: env.DATABASE_URL,
  timeoutMs: env.DB_TIMEOUT_MS,
  onIdleError: (err) => logger.error({ err }, "idle database client error"),
});

const app = createApp({ env, logger, getPool: () => getDb().pool });
export default app;

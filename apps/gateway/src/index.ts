import { loadEnv } from "./config/env.ts";
import { createApp } from "./create-app.ts";
import { createLogger } from "./logger.ts";

// Vercel entry (zero-config Hono): the default export is the app.
export const env = loadEnv(process.env);
export const logger = createLogger(env.LOG_LEVEL);

const app = createApp({ env, logger });
export default app;

import { serve } from "@hono/node-server";
import app, { env, logger } from "./index.ts";

// Long-running Node server for local dev and Docker. Serves the same app object as the Vercel entry.
serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port, profile: env.PROFILE }, "gateway listening");
});

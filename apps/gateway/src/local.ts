import { serve } from "@hono/node-server";
import { checkAndWarmUpOllama } from "./backends/ollama-health.ts";
import { createBackendRegistry } from "./backends/registry.ts";
import app, { env, logger } from "./index.ts";

// Long-running Node server for local dev and Docker. Serves the same app object as the Vercel entry.
serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port, profile: env.PROFILE }, "gateway listening");
});

// Boot check + background warm-up when the profile uses Ollama (never blocks startup).
const ollama = createBackendRegistry(env).get("ollama");
if (ollama) void checkAndWarmUpOllama(ollama, env.OLLAMA_URL, env.OLLAMA_EMBED_MODEL, logger);

import { Hono } from "hono";
import { embeddingModelFor, type Env } from "../config/env.ts";
import type { AppEnv } from "../http/types.ts";

// Liveness + config fingerprint. No secrets. Backend ids/models and reachability are added with the
// backend registry (Phase 4); DB and KB checks with the database (Phase 2 / docs/05 §2.6).
export function healthRoutes(env: Env) {
  return new Hono<AppEnv>().get("/healthz", (c) =>
    c.json({
      status: "ok",
      profile: env.PROFILE,
      embedding_model: embeddingModelFor(env),
      retrieval_mode: env.RETRIEVAL_MODE,
    }),
  );
}

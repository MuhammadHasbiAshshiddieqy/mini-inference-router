import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { AppError } from "./errors.ts";
import type { AppEnv } from "./types.ts";

export const MAX_BODY_BYTES = 64 * 1024;

// 413 before anything else reads the body (docs/03 §7).
export const limitBody = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: () => {
    throw new AppError("payload_too_large", 413, `Request body exceeds ${MAX_BODY_BYTES} bytes`);
  },
});

// JSON only for requests that carry a body (415 otherwise).
export const requireJson = createMiddleware<AppEnv>(async (c, next) => {
  if (["POST", "PUT", "PATCH"].includes(c.req.method)) {
    const type = c.req.header("content-type") ?? "";
    if (!/^application\/json\s*(;|$)/i.test(type)) {
      throw new AppError("unsupported_media_type", 415, "Content-Type must be application/json");
    }
  }
  await next();
});

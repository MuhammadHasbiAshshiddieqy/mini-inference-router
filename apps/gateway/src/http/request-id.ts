import { randomBytes } from "node:crypto";
import { createMiddleware } from "hono/factory";
import type { Logger } from "pino";
import type { AppEnv } from "./types.ts";

// UUIDv7 (RFC 9562 §5.7): 48-bit Unix ms timestamp, then random bits. Time-ordered, so request rows
// and log lines sort naturally (docs/11 §2).
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ts = BigInt(nowMs);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 9562 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// First middleware: assigns the request id, exposes it as `x-request-id`, attaches a child logger that
// carries `request_id` on every line, and logs one line at request start and end (docs/03 §10).
export function requestContext(logger: Logger) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const requestId = uuidv7();
    const log = logger.child({ request_id: requestId });
    c.set("requestId", requestId);
    c.set("logger", log);
    c.header("x-request-id", requestId);

    const startedAt = performance.now();
    log.info({ method: c.req.method, route: c.req.path }, "request start");
    await next();
    log.info({ status: c.res.status, latency_ms: Math.round(performance.now() - startedAt) }, "request end");
  });
}

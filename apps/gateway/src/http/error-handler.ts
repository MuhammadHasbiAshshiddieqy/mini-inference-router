import type { ErrorResponse } from "@mir/shared";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { AppError } from "./errors.ts";
import type { AppEnv } from "./types.ts";

function errorBody(c: Context<AppEnv>, err: AppError): ErrorResponse {
  const body: ErrorResponse = { error: { code: err.code, message: err.message, request_id: c.get("requestId") } };
  if (err.details !== undefined) body.error.details = err.details;
  return body;
}

// Single place that turns errors into the public error shape (docs/03 §7).
// AppError → its own status and code. Anything else → 500 internal_error with a generic message;
// the real error and stack are logged, never returned to the client.
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  const log = c.get("logger");
  if (err instanceof AppError) {
    const level = err.httpStatus >= 500 ? "error" : "warn";
    log[level]({ code: err.code, status: err.httpStatus }, err.message);
    return c.json(errorBody(c, err), err.httpStatus);
  }
  log.error({ err }, "unhandled error");
  return c.json(errorBody(c, new AppError("internal_error", 500, "Internal server error")), 500);
};

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) =>
  c.json(errorBody(c, new AppError("not_found", 404, `No route for ${c.req.method} ${c.req.path}`)), 404);

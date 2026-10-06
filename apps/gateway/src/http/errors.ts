import type { ErrorCode } from "@mir/shared";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// The only error type routes and services throw on purpose. The error middleware maps it to
// `{ error: { code, message, request_id, details? } }` with `httpStatus` (docs/03 §7).
export class AppError extends Error {
  override name = "AppError";
  readonly code: ErrorCode;
  readonly httpStatus: ContentfulStatusCode;
  readonly details: unknown;

  constructor(code: ErrorCode, httpStatus: ContentfulStatusCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

import { pino, type Logger, type LevelWithSilent } from "pino";

// JSON logs. Request-scoped children add `request_id` (see http/request-id.ts).
// Redaction is a safety net: code must never log keys or message bodies at info level in the first place.
export function createLogger(level: LevelWithSilent): Logger {
  return pino({
    level,
    base: { service: "gateway" },
    redact: {
      paths: [
        "authorization",
        "*.authorization",
        "headers.authorization",
        'headers["x-api-key"]',
        "apiKey",
        "*.apiKey",
      ],
      censor: "[redacted]",
    },
  });
}

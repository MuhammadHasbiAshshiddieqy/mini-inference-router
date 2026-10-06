import type { Logger } from "pino";

// Hono context variables set by middleware.
export type AppEnv = {
  Variables: {
    requestId: string;
    logger: Logger;
  };
};

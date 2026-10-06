import type { BackendId } from "@mir/shared";
import type { Logger } from "pino";

// The authenticated tenant, loaded fresh from the database on every request so policy changes apply at once.
export type Tenant = {
  id: string;
  name: string;
  quotaTokens: number;
  usedTokens: number;
  allowedBackends: BackendId[];
  maxOutputTokens: number;
  allowDebug: boolean;
};

// Hono context variables set by middleware. `tenant` is only set on /v1/* routes (after tenant auth).
export type AppEnv = {
  Variables: {
    requestId: string;
    logger: Logger;
    tenant: Tenant | undefined;
  };
};

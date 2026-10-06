import {
  AdminRequestsQuerySchema,
  type AdminRequestDetail,
  type AdminRequestsResponse,
  type AdminUsageResponse,
} from "@mir/shared";
import { Hono } from "hono";
import type { Pool } from "pg";
import { z } from "zod";
import { AppError } from "../http/errors.ts";
import type { AppEnv } from "../http/types.ts";
import { getRequestDetail, listRequests, tenantUsage } from "../metering/usage.ts";

// /admin/* (admin key required, see create-app.ts). Read-only views over the metering tables.
export function adminRoutes(getPool: () => Pool) {
  return new Hono<AppEnv>()
    .get("/usage", async (c) => {
      const body: AdminUsageResponse = { tenants: await tenantUsage(getPool()) };
      return c.json(body);
    })
    .get("/requests", async (c) => {
      const query = AdminRequestsQuerySchema.safeParse(c.req.query());
      if (!query.success) {
        throw new AppError(
          "invalid_request",
          400,
          "Invalid query parameters",
          query.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        );
      }
      const body: AdminRequestsResponse = { requests: await listRequests(getPool(), query.data) };
      return c.json(body);
    })
    .get("/requests/:id", async (c) => {
      const id = c.req.param("id");
      if (!z.uuid().safeParse(id).success) throw new AppError("invalid_request", 400, "Request id must be a UUID");
      const detail = await getRequestDetail(getPool(), id);
      if (!detail) throw new AppError("not_found", 404, `No request ${id}`);
      const body: AdminRequestDetail = detail;
      return c.json(body);
    });
}

import {
  AdminRequestDetailSchema,
  AdminRequestsResponseSchema,
  AdminUsageResponseSchema,
  ErrorResponseSchema,
  SupportRequestSchema,
  UsageResponseSchema,
} from "@mir/shared";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadEnv } from "./config/env.ts";
import { createApp } from "./create-app.ts";
import { createDb } from "./db/client.ts";
import { admit, settle } from "./http/admission.ts";
import { createLogger } from "./logger.ts";
import { insertAttempt } from "./metering/requests.ts";
import { estimateTokens, reconcileTokens, reserveTokens, type Queryable } from "./quota/quota.ts";
import { connectTestDb, createTestTenant, resetTestDb, usedTokens } from "./test-support/db.ts";

// Phase 3 request-path tests (docs/09): auth, policy, body checks, fail-closed quota, metering, admin views.
// Runs against the `router_test` database; skipped with a warning if Postgres is not running.

const db = await connectTestDb();
const ADMIN_KEY = "test-admin-key";
const logger = createLogger("silent");
const env = loadEnv({ DATABASE_URL: "postgres://u:p@localhost:5432/unused", ADMIN_API_KEY: ADMIN_KEY });

type BuildOptions = { getPool?: () => Pool; admissionDb?: Queryable; holdReservation?: boolean };

// The real middleware chain plus one test-only LLM-like route that goes through admission and settlement
// with a fake "backend" call, so the request path can be exercised before /v1/chat exists (Phase 5).
function buildApp(opts: BuildOptions = {}) {
  const getPool = opts.getPool ?? (() => db!.pool);
  const app = createApp({ env, logger, getPool });
  const backend = { calls: 0 };
  app.post("/v1/test/answer", async (c) => {
    const queryable = opts.admissionDb ?? getPool();
    const admission = await admit(c, {
      db: queryable,
      profile: "local",
      endpoint: "support",
      schema: SupportRequestSchema,
      estimatePromptTokens: (body) => estimateTokens(body.message),
    });
    backend.calls++;
    const totalTokens = opts.holdReservation ? admission.reservedTokens : 42;
    const quota = await settle(queryable, c, admission, {
      outcome: "ok",
      servedBackendId: "mock",
      servedModel: "mock",
      fallbackFired: false,
      escalated: false,
      attemptsCount: 1,
      promptTokens: 30,
      completionTokens: 12,
      thinkingTokens: 0,
      totalTokens,
      tokensEstimated: true,
      costUsd: "0.00000000",
      ttftMs: 5,
    });
    return c.json({ request_id: admission.start.id, quota });
  });
  return { app, backend };
}

const post = (key: string | undefined, body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

async function errorOf(res: Response) {
  return ErrorResponseSchema.parse(await res.json()).error;
}

async function requestRows(tenantId: string) {
  const { rows } = await db!.pool.query<{ outcome: string; error_code: string | null; total_tokens: number }>(
    "SELECT outcome, error_code, total_tokens FROM requests WHERE tenant_id = $1 ORDER BY created_at",
    [tenantId],
  );
  return rows;
}

describe.skipIf(!db)("request path (database)", () => {
  beforeEach(async () => {
    await resetTestDb(db!);
  });

  describe("auth", () => {
    it("401 missing_api_key without a key, and no backend call", async () => {
      const { app, backend } = buildApp();
      const res = await app.request("/v1/test/answer", post(undefined, { message: "hi" }));
      expect(res.status).toBe(401);
      expect((await errorOf(res)).code).toBe("missing_api_key");
      expect(backend.calls).toBe(0);
    });

    it("401 invalid_api_key for an unknown key (Bearer and x-api-key)", async () => {
      await createTestTenant(db!);
      const { app } = buildApp();
      const bearer = await app.request("/v1/test/answer", post("mir_not_a_real_key_000000000000", { message: "hi" }));
      expect((await errorOf(bearer)).code).toBe("invalid_api_key");
      const header = await app.request("/v1/test/answer", {
        ...post(undefined, { message: "hi" }),
        headers: { "content-type": "application/json", "x-api-key": "mir_not_a_real_key_000000000000" },
      });
      expect(header.status).toBe(401);
    });

    it("accepts x-api-key as well as Bearer", async () => {
      const t = await createTestTenant(db!);
      const { app } = buildApp();
      const res = await app.request("/v1/test/answer", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": t.key },
        body: JSON.stringify({ message: "hi" }),
      });
      expect(res.status).toBe(200);
    });

    it("403 tenant_disabled", async () => {
      const t = await createTestTenant(db!, { enabled: false });
      const res = await buildApp().app.request("/v1/test/answer", post(t.key, { message: "hi" }));
      expect(res.status).toBe(403);
      expect((await errorOf(res)).code).toBe("tenant_disabled");
    });
  });

  describe("body and policy checks", () => {
    it("413 payload_too_large before auth", async () => {
      const res = await buildApp().app.request("/v1/test/answer", post(undefined, { message: "x".repeat(70_000) }));
      expect(res.status).toBe(413);
      expect((await errorOf(res)).code).toBe("payload_too_large");
    });

    it("415 unsupported_media_type for non-JSON bodies", async () => {
      const t = await createTestTenant(db!);
      const res = await buildApp().app.request("/v1/test/answer", {
        method: "POST",
        headers: { "content-type": "text/plain", authorization: `Bearer ${t.key}` },
        body: "hi",
      });
      expect(res.status).toBe(415);
      expect((await errorOf(res)).code).toBe("unsupported_media_type");
    });

    it("400 invalid_request with issue details, metered as one row, no reservation", async () => {
      const t = await createTestTenant(db!);
      const { app, backend } = buildApp();
      const res = await app.request("/v1/test/answer", post(t.key, { message: "   " }));
      expect(res.status).toBe(400);
      const error = await errorOf(res);
      expect(error.code).toBe("invalid_request");
      expect(error.details).toEqual([expect.objectContaining({ path: "message" })]);
      expect(await requestRows(t.id)).toEqual([
        { outcome: "invalid_request", error_code: "invalid_request", total_tokens: 0 },
      ]);
      expect(await usedTokens(db!, t.id)).toBe(0);
      expect(backend.calls).toBe(0);
    });

    it("400 for malformed JSON", async () => {
      const t = await createTestTenant(db!);
      const res = await buildApp().app.request("/v1/test/answer", post(t.key, "{not json"));
      expect(res.status).toBe(400);
      expect((await errorOf(res)).message).toMatch(/not valid JSON/);
    });

    it("400 when max_output_tokens exceeds the tenant cap", async () => {
      const t = await createTestTenant(db!, { maxOutputTokens: 256 });
      const res = await buildApp().app.request(
        "/v1/test/answer",
        post(t.key, { message: "hi", max_output_tokens: 512 }),
      );
      expect(res.status).toBe(400);
      expect((await errorOf(res)).details).toEqual({ max_output_tokens: 256 });
    });

    it("403 debug_not_allowed for tenants without allow_debug, metered", async () => {
      const t = await createTestTenant(db!, { allowDebug: false });
      const res = await buildApp().app.request(
        "/v1/test/answer",
        post(t.key, { message: "hi", debug: { force_fail: ["gemini-3.5-flash"] } }),
      );
      expect(res.status).toBe(403);
      expect((await errorOf(res)).code).toBe("debug_not_allowed");
      expect(await requestRows(t.id)).toEqual([
        { outcome: "invalid_request", error_code: "debug_not_allowed", total_tokens: 0 },
      ]);
    });
  });

  describe("quota", () => {
    it("reserves, then reconciles to the actual tokens and finalizes the row", async () => {
      const t = await createTestTenant(db!, { quotaTokens: 10_000 });
      const { app, backend } = buildApp();
      const res = await app.request(
        "/v1/test/answer",
        post(t.key, { message: "cancel my order", max_output_tokens: 100 }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { request_id: string; quota: { used: number; remaining: number } };
      expect(body.request_id).toBe(res.headers.get("x-request-id"));
      expect(body.quota).toEqual({ limit: 10_000, used: 42, remaining: 9_958 });
      expect(await usedTokens(db!, t.id)).toBe(42);
      expect(await requestRows(t.id)).toEqual([{ outcome: "ok", error_code: null, total_tokens: 42 }]);
      expect(backend.calls).toBe(1);
    });

    it("429 quota_exceeded with limit/used/remaining/requested, metered, no backend call", async () => {
      const t = await createTestTenant(db!, { quotaTokens: 300, usedTokens: 250 });
      const { app, backend } = buildApp();
      const res = await app.request("/v1/test/answer", post(t.key, { message: "hello there", max_output_tokens: 100 }));
      expect(res.status).toBe(429);
      const error = await errorOf(res);
      expect(error.code).toBe("quota_exceeded");
      expect(error.details).toEqual({ limit: 300, used: 250, remaining: 50, requested: 103 });
      expect(await requestRows(t.id)).toEqual([
        { outcome: "quota_exceeded", error_code: "quota_exceeded", total_tokens: 0 },
      ]);
      expect(await usedTokens(db!, t.id)).toBe(250);
      expect(backend.calls).toBe(0);
    });

    it("503 quota_unavailable and no backend call when the database is down (auth fails closed)", async () => {
      const down = createDb({ databaseUrl: "postgres://postgres:postgres@127.0.0.1:1/router", timeoutMs: 1000 });
      try {
        const { app, backend } = buildApp({ getPool: () => down.pool });
        const res = await app.request("/v1/test/answer", post("mir_any_key_00000000000000000000", { message: "hi" }));
        expect(res.status).toBe(503);
        expect((await errorOf(res)).code).toBe("quota_unavailable");
        expect(backend.calls).toBe(0);
      } finally {
        await down.pool.end();
      }
    });

    it("503 quota_unavailable and no backend call when only the reservation fails", async () => {
      const t = await createTestTenant(db!);
      const failingReserve: Queryable = {
        query: (text, values) => {
          if (text.includes("used_tokens = used_tokens +")) return Promise.reject(new Error("connection reset"));
          return db!.pool.query(text, values);
        },
      };
      const { app, backend } = buildApp({ admissionDb: failingReserve });
      const res = await app.request("/v1/test/answer", post(t.key, { message: "hi" }));
      expect(res.status).toBe(503);
      expect((await errorOf(res)).code).toBe("quota_unavailable");
      expect(backend.calls).toBe(0);
      expect(await usedTokens(db!, t.id)).toBe(0);
    });

    it("never oversubscribes under concurrency: quota for N, 3N in parallel → exactly N admitted", async () => {
      const N = 5;
      // Each request reserves ceil(40/4) + 90 = 100 tokens and holds it (actual = reserved).
      const perRequest = estimateTokens("x".repeat(40)) + 90;
      const t = await createTestTenant(db!, { quotaTokens: N * perRequest });
      const { app, backend } = buildApp({ holdReservation: true });
      const responses = await Promise.all(
        Array.from({ length: 3 * N }, () =>
          app.request("/v1/test/answer", post(t.key, { message: "x".repeat(40), max_output_tokens: 90 })),
        ),
      );
      const statuses = responses.map((r) => r.status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(N);
      expect(statuses.filter((s) => s === 429)).toHaveLength(2 * N);
      expect(backend.calls).toBe(N);
      expect(await usedTokens(db!, t.id)).toBe(N * perRequest);
      const outcomes = (await requestRows(t.id)).map((r) => r.outcome);
      expect(outcomes.filter((o) => o === "ok")).toHaveLength(N);
      expect(outcomes.filter((o) => o === "quota_exceeded")).toHaveLength(2 * N);
    });

    it("reconcile math: used = used - reserved + actual, and a failed reconcile keeps the reservation", async () => {
      const t = await createTestTenant(db!, { quotaTokens: 5_000, usedTokens: 200 });
      await reserveTokens(db!.pool, t.id, 1_000);
      expect(await usedTokens(db!, t.id)).toBe(1_200);
      expect(await reconcileTokens(db!.pool, logger, t.id, 1_000, 300)).toEqual({
        limit: 5_000,
        used: 500,
        remaining: 4_500,
      });

      await reserveTokens(db!.pool, t.id, 1_000);
      const broken: Queryable = { query: () => Promise.reject(new Error("db down")) };
      expect(await reconcileTokens(broken, logger, t.id, 1_000, 0)).toBeUndefined();
      expect(await usedTokens(db!, t.id)).toBe(1_500); // never refunded on uncertainty
    });
  });

  describe("usage and admin views", () => {
    it("GET /v1/usage returns the caller's quota, policy and usage", async () => {
      const t = await createTestTenant(db!, { quotaTokens: 10_000, allowedBackends: ["gemini-3-flash", "mock"] });
      const { app } = buildApp();
      await app.request("/v1/test/answer", post(t.key, { message: "hi", max_output_tokens: 50 }));
      const res = await app.request("/v1/usage", { headers: { authorization: `Bearer ${t.key}` } });
      expect(res.status).toBe(200);
      const body = UsageResponseSchema.parse(await res.json());
      expect(body.quota).toEqual({ limit: 10_000, used: 42, remaining: 9_958 });
      expect(body.policy).toEqual({
        allowed_backends: ["gemini-3-flash", "mock"],
        allow_debug: true,
        max_output_tokens: 1024,
      });
      expect(body.usage).toMatchObject({ requests: 1, total_tokens: 42, outcomes: { ok: 1 } });
    });

    it("rejects /admin/* without the admin key, and with a tenant key", async () => {
      const t = await createTestTenant(db!);
      const { app } = buildApp();
      expect((await app.request("/admin/usage")).status).toBe(401);
      const withTenantKey = await app.request("/admin/usage", { headers: { authorization: `Bearer ${t.key}` } });
      expect((await errorOf(withTenantKey)).code).toBe("invalid_api_key");
    });

    it("GET /admin/usage lists every tenant with requests, cost, outcomes and remaining quota", async () => {
      const a = await createTestTenant(db!, { id: "acme", quotaTokens: 10_000 });
      await createTestTenant(db!, { id: "tiny", quotaTokens: 100 });
      const { app } = buildApp();
      await app.request("/v1/test/answer", post(a.key, { message: "hi", max_output_tokens: 50 }));
      await app.request("/v1/test/answer", post(a.key, { message: "   " }));
      const res = await app.request("/admin/usage", { headers: { authorization: `Bearer ${ADMIN_KEY}` } });
      const body = AdminUsageResponseSchema.parse(await res.json());
      expect(body.tenants.map((t) => t.id)).toEqual(["acme", "tiny"]);
      expect(body.tenants[0]).toMatchObject({
        quota: { limit: 10_000, used: 42, remaining: 9_958 },
        usage: { requests: 2, total_tokens: 42, outcomes: { ok: 1, invalid_request: 1 } },
      });
      expect(body.tenants[1]?.usage).toMatchObject({ requests: 0, last_request_at: null });
    });

    it("GET /admin/requests filters by tenant and outcome; /admin/requests/:id shows the attempts", async () => {
      const t = await createTestTenant(db!);
      const { app } = buildApp();
      const ok = await app.request("/v1/test/answer", post(t.key, { message: "hi", max_output_tokens: 50 }));
      const { request_id } = (await ok.json()) as { request_id: string };
      await app.request("/v1/test/answer", post(t.key, { message: "" }));
      for (const [attemptNo, status, reason] of [
        [1, "forced_failure", "primary"],
        [2, "ok", "fallback:forced_failure"],
      ] as const) {
        await insertAttempt(db!.pool, {
          requestId: request_id,
          attemptNo,
          backendId: attemptNo === 1 ? "gemini-3.5-flash" : "mock",
          model: attemptNo === 1 ? "gemini-3.5-flash" : "mock",
          reason,
          status,
          errorDetail: status === "ok" ? null : "debug.force_fail",
          promptTokens: null,
          completionTokens: null,
          thinkingTokens: null,
          costUsd: "0",
          latencyMs: 2,
          ttftMs: null,
          startedAt: new Date(),
        });
      }
      const admin = { headers: { authorization: `Bearer ${ADMIN_KEY}` } };

      const list = AdminRequestsResponseSchema.parse(
        await (await app.request(`/admin/requests?tenant=${t.id}`, admin)).json(),
      );
      expect(list.requests).toHaveLength(2);
      const okOnly = AdminRequestsResponseSchema.parse(
        await (await app.request("/admin/requests?outcome=ok", admin)).json(),
      );
      expect(okOnly.requests.map((r) => r.id)).toEqual([request_id]);

      const detail = AdminRequestDetailSchema.parse(
        await (await app.request(`/admin/requests/${request_id}`, admin)).json(),
      );
      expect(detail.request).toMatchObject({ id: request_id, outcome: "ok", cost_usd: "0.00000000" });
      expect(detail.attempts.map((a) => [a.attempt_no, a.backend_id, a.reason, a.status])).toEqual([
        [1, "gemini-3.5-flash", "primary", "forced_failure"],
        [2, "mock", "fallback:forced_failure", "ok"],
      ]);

      expect((await app.request("/admin/requests/not-a-uuid", admin)).status).toBe(400);
      expect((await app.request("/admin/requests/01900000-0000-7000-8000-000000000000", admin)).status).toBe(404);
      expect((await app.request("/admin/requests?outcome=bogus", admin)).status).toBe(400);
    });
  });
});

afterAll(async () => {
  await db?.pool.end();
});

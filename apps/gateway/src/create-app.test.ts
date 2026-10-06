import { ErrorResponseSchema } from "@mir/shared";
import { describe, expect, it } from "vitest";
import { loadEnv } from "./config/env.ts";
import { createApp } from "./create-app.ts";
import { AppError } from "./http/errors.ts";
import { createLogger } from "./logger.ts";

function buildApp() {
  const env = loadEnv({ DATABASE_URL: "postgres://u:p@localhost:5432/router", ADMIN_API_KEY: "test-admin" });
  const app = createApp({ env, logger: createLogger("silent") });
  // Test-only routes to exercise the error middleware.
  app.get("/test/app-error", () => {
    throw new AppError("quota_exceeded", 429, "Token quota exhausted", { remaining: 0 });
  });
  app.get("/test/crash", () => {
    throw new Error("db password is hunter2");
  });
  return app;
}

describe("gateway app", () => {
  it("GET /healthz returns 200 with the config fingerprint and a request id", async () => {
    const res = await buildApp().request("/healthz");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await res.json()).toEqual({
      status: "ok",
      profile: "local",
      embedding_model: "nomic-embed-text",
      retrieval_mode: "dense",
    });
  });

  it("gives every request a distinct request id", async () => {
    const app = buildApp();
    const [a, b] = await Promise.all([app.request("/healthz"), app.request("/healthz")]);
    expect(a.headers.get("x-request-id")).not.toBe(b.headers.get("x-request-id"));
  });

  it("maps AppError to its status, code, details and the request id", async () => {
    const res = await buildApp().request("/test/app-error");
    expect(res.status).toBe(429);
    const body = ErrorResponseSchema.parse(await res.json());
    expect(body.error).toEqual({
      code: "quota_exceeded",
      message: "Token quota exhausted",
      request_id: res.headers.get("x-request-id"),
      details: { remaining: 0 },
    });
  });

  it("maps unexpected errors to a generic 500 without leaking the message", async () => {
    const res = await buildApp().request("/test/crash");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("hunter2");
    const body = ErrorResponseSchema.parse(JSON.parse(text));
    expect(body.error.code).toBe("internal_error");
    expect(body.error.request_id).toBe(res.headers.get("x-request-id"));
  });

  it("returns the JSON error shape for unknown routes", async () => {
    const res = await buildApp().request("/v1/nope", { method: "POST" });
    expect(res.status).toBe(404);
    const body = ErrorResponseSchema.parse(await res.json());
    expect(body.error.code).toBe("not_found");
  });
});

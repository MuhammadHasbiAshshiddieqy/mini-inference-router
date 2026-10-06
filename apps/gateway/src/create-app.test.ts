import { ErrorResponseSchema } from "@mir/shared";
import { describe, expect, it } from "vitest";
import { loadEnv } from "./config/env.ts";
import { createApp } from "./create-app.ts";
import { AppError } from "./http/errors.ts";
import { createLogger } from "./logger.ts";

function buildApp() {
  const env = loadEnv({ DATABASE_URL: "postgres://u:p@localhost:5432/router", ADMIN_API_KEY: "test-admin" });
  const getPool = () => {
    throw new Error("these tests must not touch the database");
  };
  const probeOllama = async (_host: string, models: string[]) => ({
    reachable: true,
    models_present: Object.fromEntries(models.map((m) => [m, true])),
  });
  const checkAssistant = async () => ({ ok: true, kb_rows: 1350, pg_trgm: true, problems: [] });
  const app = createApp({ env, logger: createLogger("silent"), getPool, probeOllama, checkAssistant });
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
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "ok",
      profile: "local",
      embedding_model: "nomic-embed-text",
      retrieval_mode: "dense",
      thinking_level: null,
      ollama: { reachable: true, models_present: { "gemma4:e2b-mlx": true, "nomic-embed-text": true } },
    });
    expect(body["backends"]).toEqual([
      expect.objectContaining({ id: "ollama", model: "gemma4:e2b-mlx", priority: 0, supports_tools: true }),
      expect.objectContaining({ id: "mock", model: "mock", priority: 1, supports_tools: false }),
    ]);
    expect(JSON.stringify(body)).not.toMatch(/api_key|test-admin/i); // no secrets in the fingerprint
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
    const res = await buildApp().request("/nope", { method: "POST" });
    expect(res.status).toBe(404);
    const body = ErrorResponseSchema.parse(await res.json());
    expect(body.error.code).toBe("not_found");
  });
});

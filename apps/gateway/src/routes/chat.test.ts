import {
  ChatResponseSchema,
  ErrorResponseSchema,
  parseSseEvent,
  parseSseText,
  type BackendId,
  type SseEvent,
} from "@mir/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createMockBackend } from "../backends/mock.ts";
import type { BackendRegistry } from "../backends/registry.ts";
import { BackendError, type Backend, type GenerateRequest, type StreamChunk } from "../backends/types.ts";
import { loadEnv } from "../config/env.ts";
import { backendSpecs } from "../config/profiles.ts";
import { createApp } from "../create-app.ts";
import { createLogger } from "../logger.ts";
import { connectTestDb, createTestTenant, resetTestDb, usedTokens } from "../test-support/db.ts";

// Phase 5: POST /v1/chat end to end (auth → admission → plan → execute → SSE → metering), with a scripted
// "ollama" backend and the real mock backend. Runs against the router_test database.

const db = await connectTestDb();
const env = loadEnv({ DATABASE_URL: "postgres://u:p@localhost:5432/unused", ADMIN_API_KEY: "test-admin-key" });
const logger = createLogger("silent");
const specs = backendSpecs(env); // local profile: ollama → mock

type Step = { wait?: number; text?: string; usage?: [number, number]; fail?: BackendError };

function scripted(steps: Step[]) {
  const seen: GenerateRequest[] = [];
  const spec = specs.find((s) => s.id === "ollama")!;
  const backend: Backend = {
    spec,
    async *stream(req): AsyncIterable<StreamChunk> {
      seen.push(req);
      for (const step of steps) {
        if (step.wait) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, step.wait);
            req.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new BackendError("aborted", "aborted"));
            });
          });
        }
        if (step.fail) throw step.fail;
        if (step.text) yield { type: "text", text: step.text };
        if (step.usage) {
          yield {
            type: "usage",
            promptTokens: step.usage[0],
            completionTokens: step.usage[1],
            thinkingTokens: 0,
            estimated: false,
          };
        }
      }
    },
  };
  return { backend, seen };
}

function buildApp(ollamaSteps: Step[], opts: { heartbeatMs?: number } = {}) {
  const ollama = scripted(ollamaSteps);
  const mock = createMockBackend(
    specs.find((s) => s.id === "mock")!,
    { latencyMs: 0, failRate: 0 },
  );
  const backends = [ollama.backend, mock];
  const registry: BackendRegistry = { backends, get: (id: BackendId) => backends.find((b) => b.spec.id === id) };
  const app = createApp({ env, logger, getPool: () => db!.pool, registry, ...opts });
  return { app, ollama };
}

const chat = (key: string, body: Record<string, unknown>, init: RequestInit = {}) =>
  new Request("http://gateway.test/v1/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ messages: [{ role: "user", content: "How do I track my refund?" }], ...body }),
    ...init,
  });

function events(text: string): SseEvent[] {
  return parseSseText(text).map((raw) => {
    const parsed = parseSseEvent(raw.event, JSON.parse(raw.data));
    if (!parsed.ok) throw new Error(`invalid SSE event ${raw.event}: ${JSON.stringify(parsed)}`);
    return parsed.event;
  });
}
const names = (evs: SseEvent[]) => evs.map((e) => e.event);
const done = (evs: SseEvent[]) =>
  evs.find((e) => e.event === "done")?.data as Extract<SseEvent, { event: "done" }>["data"];

async function rows(tenantId: string) {
  const req = await db!.pool.query<{
    id: string;
    outcome: string;
    served_backend_id: string | null;
    fallback_fired: boolean;
    total_tokens: number;
    error_code: string | null;
  }>(
    "SELECT id, outcome, served_backend_id, fallback_fired, total_tokens, error_code FROM requests WHERE tenant_id = $1 ORDER BY created_at",
    [tenantId],
  );
  const attempts = await db!.pool.query<{ attempt_no: number; backend_id: string; reason: string; status: string }>(
    `SELECT a.attempt_no, a.backend_id, a.reason, a.status FROM route_attempts a JOIN requests r ON r.id = a.request_id
     WHERE r.tenant_id = $1 ORDER BY a.request_id, a.attempt_no`,
    [tenantId],
  );
  return { requests: req.rows, attempts: attempts.rows };
}

describe.skipIf(!db)("POST /v1/chat (database)", () => {
  beforeEach(async () => {
    await resetTestDb(db!);
  });

  it("streams meta → route → tokens → done with anti-buffering headers, and meters exactly once", async () => {
    const t = await createTestTenant(db!, { quotaTokens: 10_000 });
    const { app, ollama } = buildApp([{ wait: 5, text: "Open " }, { wait: 5, text: "Orders." }, { usage: [40, 6] }]);
    const res = await app.request(
      chat(t.key, {
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "How do I track my refund?" },
        ],
        max_output_tokens: 100,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const evs = events(await res.text());
    expect(names(evs)).toEqual(["meta", "route", "token", "token", "done"]);
    expect(evs[0]).toEqual({
      event: "meta",
      data: { request_id: res.headers.get("x-request-id"), tenant: "acme", endpoint: "chat", profile: "local" },
    });
    expect(evs[1]?.data).toEqual({ attempt: 1, backend_id: "ollama", model: "gemma4:e2b-mlx", reason: "primary" });
    expect(done(evs)).toMatchObject({
      outcome: "ok",
      served_by: { backend_id: "ollama", model: "gemma4:e2b-mlx" },
      fallback_fired: false,
      usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46, estimated: false },
      quota: { limit: 10_000, used: 46, remaining: 9_954 },
      decisions: [],
    });
    expect(done(evs).ttft_ms).not.toBeNull();

    // System messages become the backend's system instruction; the rest are turns.
    expect(ollama.seen[0]?.system).toBe("Be brief.");
    expect(ollama.seen[0]?.messages).toEqual([{ role: "user", content: "How do I track my refund?" }]);
    expect(ollama.seen[0]?.maxOutputTokens).toBe(100);

    const { requests, attempts } = await rows(t.id);
    expect(requests).toEqual([
      expect.objectContaining({ outcome: "ok", served_backend_id: "ollama", fallback_fired: false, total_tokens: 46 }),
    ]);
    expect(attempts).toEqual([{ attempt_no: 1, backend_id: "ollama", reason: "primary", status: "ok" }]);
    expect(await usedTokens(db!, t.id)).toBe(46);
  });

  it("debug.force_fail on the primary → attempt_failed, fallback to mock, ok_after_fallback", async () => {
    const t = await createTestTenant(db!);
    const { app, ollama } = buildApp([{ text: "never" }]);
    const res = await app.request(chat(t.key, { debug: { force_fail: ["ollama"] } }));
    const evs = events(await res.text());
    expect(names(evs).filter((n) => n !== "token")).toEqual(["meta", "route", "attempt_failed", "route", "done"]);
    expect(evs[2]?.data).toMatchObject({ attempt: 1, backend_id: "ollama", status: "forced_failure" });
    expect(evs[3]?.data).toMatchObject({ attempt: 2, backend_id: "mock", reason: "fallback:forced_failure" });
    const text = evs.flatMap((e) => (e.event === "token" ? [e.data.text] : [])).join("");
    expect(text).toMatch(/^\[mock\]/);
    expect(done(evs)).toMatchObject({
      outcome: "ok_after_fallback",
      fallback_fired: true,
      served_by: { backend_id: "mock" },
    });
    expect(done(evs).usage.estimated).toBe(true);
    expect(ollama.seen).toHaveLength(0);

    const { requests, attempts } = await rows(t.id);
    expect(requests[0]).toMatchObject({
      outcome: "ok_after_fallback",
      fallback_fired: true,
      served_backend_id: "mock",
    });
    expect(attempts.map((a) => [a.backend_id, a.reason, a.status])).toEqual([
      ["ollama", "primary", "forced_failure"],
      ["mock", "fallback:forced_failure", "ok"],
    ]);
  });

  it("failure after the first token → error event + done(partial_error), no fallback", async () => {
    const t = await createTestTenant(db!);
    const { app } = buildApp([
      { text: "To track your refund, " },
      { wait: 5, fail: new BackendError("upstream_error", "connection reset") },
    ]);
    const evs = events(await (await app.request(chat(t.key, {}))).text());
    expect(names(evs)).toEqual(["meta", "route", "token", "attempt_failed", "error", "done"]);
    expect(evs[3]?.data).toMatchObject({ status: "mid_stream_error" });
    expect(evs[4]).toEqual({
      event: "error",
      data: { code: "mid_stream_error", message: "upstream_error: connection reset" },
    });
    expect(done(evs)).toMatchObject({ outcome: "partial_error", served_by: { backend_id: "ollama" } });
    const { requests, attempts } = await rows(t.id);
    expect(requests[0]).toMatchObject({ outcome: "partial_error", error_code: "mid_stream_error" });
    expect(attempts).toHaveLength(1);
  });

  it("every backend fails → SSE error(all_backends_failed) + done; JSON mode → 502 with attempts", async () => {
    const t = await createTestTenant(db!);
    const { app } = buildApp([{ fail: new BackendError("network_error", "ECONNREFUSED") }]);
    const evs = events(await (await app.request(chat(t.key, { debug: { mock_fail: true } }))).text());
    expect(names(evs)).toEqual(["meta", "route", "attempt_failed", "route", "attempt_failed", "error", "done"]);
    expect(evs[5]?.data).toMatchObject({ code: "all_backends_failed" });
    expect(done(evs)).toMatchObject({ outcome: "all_backends_failed", served_by: null });

    const json = await app.request(chat(t.key, { stream: false, debug: { mock_fail: true } }));
    expect(json.status).toBe(502);
    const error = ErrorResponseSchema.parse(await json.json()).error;
    expect(error.code).toBe("all_backends_failed");
    expect(error.details).toMatchObject({
      attempts: [
        { backend_id: "ollama", status: "network_error" },
        { backend_id: "mock", status: "upstream_error", reason: "fallback:network_error" },
      ],
    });
    expect((await rows(t.id)).requests.map((r) => r.outcome)).toEqual(["all_backends_failed", "all_backends_failed"]);
  });

  it("stream:false returns one JSON object; a mid-generation failure still falls back (nothing was sent yet)", async () => {
    const t = await createTestTenant(db!);
    const { app } = buildApp([{ text: "half an ans" }, { fail: new BackendError("upstream_error", "reset") }]);
    const res = await app.request(chat(t.key, { stream: false }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = ChatResponseSchema.parse(await res.json());
    expect(body.answer).toMatch(/^\[mock\]/); // the failed attempt's partial text is discarded
    expect(body).toMatchObject({
      outcome: "ok_after_fallback",
      fallback_fired: true,
      served_by: { backend_id: "mock" },
    });
    expect(body.attempts.map((a) => [a.backend_id, a.status])).toEqual([
      ["ollama", "upstream_error"],
      ["mock", "ok"],
    ]);
    expect(body.request_id).toBe(res.headers.get("x-request-id"));
  });

  it("routing policy errors are plain JSON and metered: 422 tools_unsupported, 403 no_allowed_backend", async () => {
    const restricted = await createTestTenant(db!, { id: "mockonly", allowedBackends: ["mock"] });
    const tools = [{ name: "get_order_status", parameters: { type: "object" } }];
    const { app } = buildApp([]);
    const toolsRes = await app.request(chat(restricted.key, { tools }));
    expect(toolsRes.status).toBe(422);
    expect(ErrorResponseSchema.parse(await toolsRes.json()).error.code).toBe("tools_unsupported");

    const cloudOnly = await createTestTenant(db!, { id: "cloudonly", allowedBackends: ["gemini-3.5-flash"] });
    const policyRes = await app.request(chat(cloudOnly.key, {}));
    expect(policyRes.status).toBe(403);
    expect(ErrorResponseSchema.parse(await policyRes.json()).error.code).toBe("no_allowed_backend");

    expect((await rows("mockonly")).requests).toEqual([
      expect.objectContaining({ outcome: "invalid_request", error_code: "tools_unsupported" }),
    ]);
    expect(await usedTokens(db!, "mockonly")).toBe(0); // planned before reserving: nothing to refund
  });

  it("a system-only conversation is rejected with 400", async () => {
    const t = await createTestTenant(db!);
    const res = await buildApp([]).app.request(chat(t.key, { messages: [{ role: "system", content: "x" }] }));
    expect(res.status).toBe(400);
  });

  it("client disconnect aborts the upstream generation and is metered as client_aborted", async () => {
    const t = await createTestTenant(db!, { quotaTokens: 10_000 });
    const { app, ollama } = buildApp([{ text: "Starting… " }, { wait: 30_000, text: "never sent" }]);
    const client = new AbortController();
    const res = await app.request(chat(t.key, { max_output_tokens: 100 }, { signal: client.signal }));
    const reader = res.body!.getReader();
    let received = "";
    while (!received.includes("event: token")) received += new TextDecoder().decode((await reader.read()).value);
    client.abort();
    await reader.cancel();

    let outcome: string | undefined;
    for (let i = 0; i < 50 && outcome !== "client_aborted"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      outcome = (await rows(t.id)).requests[0]?.outcome;
    }
    expect(outcome).toBe("client_aborted");
    expect(ollama.seen[0]?.signal.aborted).toBe(true);
    expect((await rows(t.id)).attempts.map((a) => a.status)).toEqual(["aborted"]);
    // The backend never sent its usage chunk, so the streamed content is metered as an estimate (not 0):
    // prompt ceil(25/4) = 7 + completion ceil(10/4) = 3.
    const { rows: est } = await db!.pool.query<{ total_tokens: number; tokens_estimated: boolean }>(
      "SELECT total_tokens, tokens_estimated FROM requests WHERE tenant_id = $1",
      [t.id],
    );
    expect(est[0]).toEqual({ total_tokens: 10, tokens_estimated: true });
    expect(await usedTokens(db!, t.id)).toBe(10); // reservation reconciled to the estimate
  });

  it("sends `: ping` heartbeats while the backend is silent", async () => {
    const t = await createTestTenant(db!);
    const { app } = buildApp([{ wait: 120, text: "late" }, { usage: [1, 1] }], { heartbeatMs: 25 });
    const raw = await (await app.request(chat(t.key, {}))).text();
    expect(raw).toContain(": ping\n\n");
    expect(names(events(raw))).toEqual(["meta", "route", "token", "done"]);
  });
});

afterAll(async () => {
  await db?.pool.end();
});

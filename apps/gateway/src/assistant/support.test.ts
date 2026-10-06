import {
  ErrorResponseSchema,
  SupportResponseSchema,
  normalize,
  parseSseEvent,
  parseSseText,
  type BackendId,
  type Intent,
  type SseEvent,
} from "@mir/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMockBackend } from "../backends/mock.ts";
import type { BackendRegistry } from "../backends/registry.ts";
import type { Backend, GenerateRequest, StreamChunk } from "../backends/types.ts";
import { loadEnv } from "../config/env.ts";
import { backendSpecs } from "../config/profiles.ts";
import type { ThresholdsResult } from "../config/thresholds.ts";
import { createApp } from "../create-app.ts";
import { EMBEDDING_DIMS, EmbeddingError, l2Normalize, type Embedder } from "../embeddings/types.ts";
import { createLogger } from "../logger.ts";
import { connectTestDb, createTestTenant, resetTestDb, usedTokens } from "../test-support/db.ts";
import { FORMAT_REMINDER } from "./prompt.ts";
import { retrieve } from "./retrieve.ts";

// docs/05 §9: retrieval modes, gating, lexical fallback, and the support route (event order, pre-gate,
// escalation, unusable output, disagreement, mock fallback). Uses a SYNTHETIC KB in the test database:
// hand-built 768-dim vectors and a fake query embedder, so every case is deterministic and offline.

const db = await connectTestDb();
const MODEL = "test-embed";
const logger = createLogger("silent");

const basis = (weights: Record<number, number>) => {
  const v = new Array<number>(EMBEDDING_DIMS).fill(0);
  for (const [i, w] of Object.entries(weights)) v[Number(i)] = w;
  return l2Normalize(v);
};

const KB: { id: string; intent: Intent; instruction: string; response: string; vector: number[] }[] = [
  {
    id: "kb-01",
    intent: "cancel_order",
    instruction: "i want to cancel my order",
    response: "To cancel order {{Order Number}}, open Orders and choose Cancel.",
    vector: basis({ 0: 1 }),
  },
  {
    id: "kb-02",
    intent: "cancel_order",
    instruction: "cancel purchase {{Order Number}}",
    response: "You can cancel purchase {{Order Number}} from your account.",
    vector: basis({ 0: 0.9, 1: 0.1 }),
  },
  {
    id: "kb-03",
    intent: "cancel_order",
    instruction: "how can i cancel an order",
    response: "Cancelling is easy: go to Orders.",
    vector: basis({ 0: 0.8, 2: 0.2 }),
  },
  {
    id: "kb-04",
    intent: "track_refund",
    instruction: "where is my refund",
    response: "Check the refund status in {{Online Company Portal Info}}.",
    vector: basis({ 3: 1 }),
  },
  {
    id: "kb-05",
    intent: "track_refund",
    instruction: "check refund status",
    response: "Your refund status is under Refunds.",
    vector: basis({ 3: 0.9, 4: 0.1 }),
  },
  {
    id: "kb-06",
    intent: "track_refund",
    instruction: "how is my refund going",
    response: "Refunds take 5-7 days; see Refunds.",
    vector: basis({ 3: 0.95, 4: 0.05 }),
  },
  {
    id: "kb-07",
    intent: "get_refund",
    instruction: "i want a refund",
    response: "Request a refund under Orders > Refund.",
    vector: basis({ 3: 0.4, 5: 0.6 }),
  },
  {
    id: "kb-08",
    intent: "place_order",
    instruction: "i want to place an order",
    response: "Add items to the cart and check out.",
    vector: basis({ 6: 1 }),
  },
  {
    id: "kb-09",
    intent: "place_order",
    instruction: "help me buy something",
    response: "Browse the catalogue and add to cart.",
    vector: basis({ 6: 0.9, 7: 0.1 }),
  },
  {
    id: "kb-10",
    intent: "create_account",
    instruction: "create an account",
    response: "Sign up at {{Signup Page}}.",
    vector: basis({ 8: 1 }),
  },
];

// Query → vector. Unknown queries land on an unrelated direction (dense similarity 0 with every KB row).
const QUERIES: Record<string, number[]> = {
  "where is my refund?": basis({ 3: 0.97, 4: 0.03 }),
  // A typo the embedding gets wrong (closest to place_order), but trigram matches cancel_order.
  "cancel my oorder": basis({ 6: 0.7, 0: 0.3 }),
  "can you order a pizza for me": basis({ 9: 1 }),
};

const fakeEmbedder = (opts: { fail?: boolean } = {}): Embedder => ({
  provider: "ollama",
  model: MODEL,
  embedDocuments: async () => [],
  embedQueries: async (texts) => texts.map((t) => QUERIES[t] ?? basis({ 10: 1 })),
  embedQuery: async (text) => {
    if (opts.fail) throw new EmbeddingError("embedding service down");
    return QUERIES[text] ?? basis({ 10: 1 });
  },
});

async function seedKb() {
  await db!.pool.query("DELETE FROM kb_entries WHERE embedding_model = $1", [MODEL]);
  for (const e of KB) {
    await db!.pool.query(
      `INSERT INTO kb_entries (id, embedding_model, intent, category, flags, instruction, response, instruction_norm, embedding)
       VALUES ($1, $2, $3, 'TEST', 'B', $4, $5, $6, $7)`,
      [e.id, MODEL, e.intent, e.instruction, e.response, normalize(e.instruction), `[${e.vector.join(",")}]`],
    );
  }
}

const env = loadEnv({
  DATABASE_URL: "postgres://u:p@localhost:5432/unused",
  ADMIN_API_KEY: "test-admin-key",
  RETRIEVAL_TOP_K: "3",
});
const specs = backendSpecs(env);
const T = { T_oos: 0.5, T_high: 0.8, T_trgm_oos: 0.25 };

// A scripted "ollama" backend: call i streams outputs[i] (the last one repeats), in small chunks.
function scripted(outputs: string[]) {
  const calls: GenerateRequest[] = [];
  const backend: Backend = {
    spec: specs.find((s) => s.id === "ollama")!,
    async *stream(req): AsyncIterable<StreamChunk> {
      calls.push(req);
      const text = outputs[Math.min(calls.length - 1, outputs.length - 1)] ?? "";
      for (let i = 0; i < text.length; i += 7) yield { type: "text", text: text.slice(i, i + 7) };
      yield {
        type: "usage",
        promptTokens: 300,
        completionTokens: Math.ceil(text.length / 4),
        thinkingTokens: 0,
        estimated: false,
      };
    },
  };
  return { backend, calls };
}

function buildApp(
  outputs: string[],
  opts: { thresholds?: ThresholdsResult; embedderFails?: boolean; mode?: "dense" | "hybrid" } = {},
) {
  const ollama = scripted(outputs);
  const mock = createMockBackend(
    specs.find((s) => s.id === "mock")!,
    { latencyMs: 0, failRate: 0 },
  );
  const backends = [ollama.backend, mock];
  const registry: BackendRegistry = { backends, get: (id: BackendId) => backends.find((b) => b.spec.id === id) };
  const app = createApp({
    env: { ...env, RETRIEVAL_MODE: opts.mode ?? "dense" },
    logger,
    getPool: () => db!.pool,
    registry,
    embedder: fakeEmbedder({ fail: opts.embedderFails ?? false }),
    thresholds: opts.thresholds ?? { ok: true, thresholds: T },
    checkAssistant: async () => ({ ok: true, kb_rows: KB.length, pg_trgm: true, problems: [] }),
  });
  return { app, ollama };
}

// The app filters kb_entries by the env's embedding model; point it at the synthetic rows.
env.OLLAMA_EMBED_MODEL = MODEL;

const ask = (key: string, message: string, extra: Record<string, unknown> = {}) =>
  new Request("http://gateway.test/v1/support/answer", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ message, ...extra }),
  });

async function sse(res: Response): Promise<SseEvent[]> {
  return parseSseText(await res.text()).map((raw) => {
    const parsed = parseSseEvent(raw.event, JSON.parse(raw.data));
    if (!parsed.ok) throw new Error(`invalid ${raw.event}: ${JSON.stringify(parsed)}`);
    return parsed.event;
  });
}
const names = (evs: SseEvent[]) => evs.map((e) => e.event).filter((n) => n !== "token");
const pick = <N extends SseEvent["event"]>(evs: SseEvent[], name: N) =>
  evs.find((e) => e.event === name)?.data as Extract<SseEvent, { event: N }>["data"];
const text = (evs: SseEvent[]) => evs.flatMap((e) => (e.event === "token" ? [e.data.text] : [])).join("");

async function lastRequest(tenantId: string) {
  const { rows } = await db!.pool.query(
    `SELECT outcome, intent, confidence_level, escalated, fallback_fired, retrieval_mode, retrieved_ids, total_tokens, served_backend_id
     FROM requests WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [tenantId],
  );
  return rows[0] as Record<string, unknown>;
}
async function attemptRows(tenantId: string) {
  const { rows } = await db!.pool.query<{ attempt_no: number; backend_id: string; reason: string; status: string }>(
    `SELECT a.attempt_no, a.backend_id, a.reason, a.status FROM route_attempts a JOIN requests r ON r.id = a.request_id
     WHERE r.tenant_id = $1 ORDER BY a.attempt_no`,
    [tenantId],
  );
  return rows.map((r) => `#${r.attempt_no} ${r.backend_id} ${r.reason} ${r.status}`);
}

describe.skipIf(!db)("retrieval (synthetic KB)", () => {
  beforeAll(seedKb);
  const base = {
    db: db?.pool as never,
    embeddingModel: MODEL,
    topK: 3,
    candidates: 20,
    rrfK: 60,
    lexicalFallback: true,
    logger,
  };

  it("dense and hybrid return k rows with the scores of their mode", async () => {
    const dense = await retrieve({ ...base, embedder: fakeEmbedder(), query: "where is my refund?", mode: "dense" });
    expect(dense.mode).toBe("dense");
    expect(dense.entries).toHaveLength(3);
    expect(dense.entries.map((e) => e.intent)).toEqual(["track_refund", "track_refund", "track_refund"]);
    expect(dense.entries[0]).toMatchObject({ dense_rank: 1, trgm_sim: null, rrf: null, lex_rank: null });
    expect(dense.signals).toMatchObject({ knnIntent: "track_refund", voteShare: 1 });

    const hybrid = await retrieve({ ...base, embedder: fakeEmbedder(), query: "where is my refund?", mode: "hybrid" });
    expect(hybrid.entries).toHaveLength(3);
    for (const e of hybrid.entries) {
      expect(e.dense_sim).not.toBeNull();
      expect(e.trgm_sim).not.toBeNull();
      expect(e.rrf).toBeGreaterThan(0);
    }
  });

  it("a typo the embedding gets wrong is rescued by hybrid ranking (trigram)", async () => {
    const dense = await retrieve({ ...base, embedder: fakeEmbedder(), query: "cancel my oorder", mode: "dense" });
    expect(dense.entries[0]?.intent).toBe("place_order");
    const hybrid = await retrieve({ ...base, embedder: fakeEmbedder(), query: "cancel my oorder", mode: "hybrid" });
    expect(hybrid.entries[0]?.intent).toBe("cancel_order");
    expect(hybrid.entries[0]?.lex_rank).toBe(1);
  });

  it("the gate uses the true dense top-1, not the RRF-first entry", async () => {
    const hybrid = await retrieve({ ...base, embedder: fakeEmbedder(), query: "cancel my oorder", mode: "hybrid" });
    const denseOfFirst = hybrid.entries[0]!.dense_sim!;
    expect(hybrid.signals.top1Similarity).toBeGreaterThan(denseOfFirst); // place_order's dense sim, not cancel's
    expect(hybrid.signals.top1Similarity).toBeCloseTo(0.7 / Math.hypot(0.7, 0.3), 5);
  });

  it("an OOS query with common words ('order a pizza') stays below the dense gate in hybrid mode", async () => {
    const hybrid = await retrieve({
      ...base,
      embedder: fakeEmbedder(),
      query: "can you order a pizza for me",
      mode: "hybrid",
    });
    expect(hybrid.entries.some((e) => (e.trgm_sim ?? 0) > 0.1)).toBe(true); // lexical overlap exists…
    expect(hybrid.signals.top1Similarity).toBeLessThan(T.T_oos); // …but the gate is dense
  });

  it("embedding failure (after one retry) → lexical fallback with trigram scores", async () => {
    const lexical = await retrieve({
      ...base,
      embedder: fakeEmbedder({ fail: true }),
      query: "cancel my oorder",
      mode: "hybrid",
    });
    expect(lexical.mode).toBe("lexical_fallback");
    expect(lexical.entries[0]).toMatchObject({ intent: "cancel_order", dense_sim: null, lex_rank: 1 });
    expect(lexical.embeddingError).toMatch(/embedding service down/);
    await expect(
      retrieve({ ...base, lexicalFallback: false, embedder: fakeEmbedder({ fail: true }), query: "x", mode: "dense" }),
    ).rejects.toMatchObject({ code: "embedding_unavailable", httpStatus: 503 });
  });
});

describe.skipIf(!db)("POST /v1/support/answer (synthetic KB)", () => {
  beforeAll(seedKb);
  beforeEach(async () => {
    await resetTestDb(db!);
  });

  it("happy path: meta → retrieval → route → intent → tokens → done, metered with intent and confidence", async () => {
    const t = await createTestTenant(db!);
    const { app, ollama } = buildApp([
      "INTENT: track_refund\n---\nYou can check the refund status in {{Online Company Portal Info}}.",
    ]);
    const res = await app.request(ask(t.key, "where is my refund?"));
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const evs = await sse(res);
    expect(names(evs)).toEqual(["meta", "retrieval", "route", "intent", "done"]);
    expect(pick(evs, "retrieval")).toMatchObject({ mode: "dense", knn_intent: "track_refund", vote_share: 1 });
    expect(pick(evs, "intent")).toMatchObject({
      llm_intent: "track_refund",
      final_intent: "track_refund",
      confidence: { level: "high", signals: { agree: true, escalated: false, retrieval_mode: "dense" } },
    });
    expect(text(evs)).toBe("You can check the refund status in {{Online Company Portal Info}}.");
    expect(pick(evs, "done")).toMatchObject({ outcome: "ok", escalated: false, served_by: { backend_id: "ollama" } });
    expect(ollama.calls[0]?.messages[0]?.content).toContain("[1] intent=track_refund similarity=");
    expect(await lastRequest(t.id)).toMatchObject({
      outcome: "ok",
      intent: "track_refund",
      confidence_level: "high",
      escalated: false,
      retrieval_mode: "dense",
      retrieved_ids: ["kb-06", "kb-04", "kb-05"], // dense order: kb-06 (0.95, 0.05) is closest to (0.97, 0.03)
    });
  });

  it("pre-gate refusal makes NO backend call and charges 0 tokens", async () => {
    const t = await createTestTenant(db!, { quotaTokens: 50_000 });
    const { app, ollama } = buildApp(["INTENT: place_order\n---\nSure."]);
    const evs = await sse(await app.request(ask(t.key, "can you order a pizza for me")));
    expect(names(evs)).toEqual(["meta", "retrieval", "refusal", "done"]);
    expect(pick(evs, "refusal")).toMatchObject({ reason: "low_retrieval_similarity" });
    expect(pick(evs, "done")).toMatchObject({ outcome: "refused", served_by: null, usage: { total_tokens: 0 } });
    expect(ollama.calls).toHaveLength(0);
    expect(await usedTokens(db!, t.id)).toBe(0);
    expect(await lastRequest(t.id)).toMatchObject({ outcome: "refused", total_tokens: 0, confidence_level: "low" });
  });

  it("invalid output → escalation (same backend, thinking low, format reminder) → success", async () => {
    const t = await createTestTenant(db!);
    const { app, ollama } = buildApp([
      "Sure! Here is how you can check your refund status.",
      "INTENT: track_refund\n---\nCheck Refunds.",
    ]);
    const evs = await sse(await app.request(ask(t.key, "where is my refund?")));
    expect(names(evs)).toEqual(["meta", "retrieval", "route", "attempt_failed", "route", "intent", "done"]);
    expect(pick(evs, "attempt_failed")).toMatchObject({ status: "invalid_output" });
    expect(text(evs)).toBe("Check Refunds."); // nothing from the invalid attempt reached the client
    expect(pick(evs, "done")).toMatchObject({ outcome: "ok", escalated: true, fallback_fired: false });
    expect(ollama.calls[1]?.system).toContain(FORMAT_REMINDER);
    expect(ollama.calls[1]?.overrides).toEqual({ thinkingLevel: "low" });
    expect(await attemptRows(t.id)).toEqual([
      "#1 ollama primary invalid_output",
      "#2 ollama escalation:invalid_output ok",
    ]);
  });

  it("invalid output twice → refusal unusable_model_output", async () => {
    const t = await createTestTenant(db!);
    const { app } = buildApp(['{"intent":"track_refund"}']);
    const evs = await sse(await app.request(ask(t.key, "where is my refund?")));
    expect(pick(evs, "refusal")).toMatchObject({ reason: "unusable_model_output" });
    expect(pick(evs, "done")).toMatchObject({ outcome: "refused", escalated: true });
    expect(text(evs)).toBe("");
    expect(await attemptRows(t.id)).toEqual([
      "#1 ollama primary invalid_output",
      "#2 ollama escalation:invalid_output invalid_output",
    ]);
  });

  it("intent disagreement → escalate; still disagreeing against strong evidence → refuse intent_disagreement", async () => {
    const t = await createTestTenant(db!);
    const { app } = buildApp(["INTENT: get_refund\n---\nRequest a refund."]);
    const evs = await sse(await app.request(ask(t.key, "where is my refund?")));
    expect(names(evs)).toEqual(["meta", "retrieval", "route", "route", "intent", "refusal", "done"]);
    expect(pick(evs, "intent")).toMatchObject({
      llm_intent: "get_refund",
      confidence: { level: "low", signals: { agree: false, escalated: true } },
    });
    expect(pick(evs, "refusal")).toMatchObject({ reason: "intent_disagreement" });
    expect(await attemptRows(t.id)).toEqual(["#1 ollama primary ok", "#2 ollama escalation:intent_disagreement ok"]);
  });

  it("intent disagreement after escalation without strong evidence → answer medium with the LLM intent", async () => {
    const t = await createTestTenant(db!);
    const { app } = buildApp(["INTENT: get_refund\n---\nRequest a refund."], {
      thresholds: { ok: true, thresholds: { ...T, T_high: 1 } },
    });
    const evs = await sse(await app.request(ask(t.key, "where is my refund?")));
    expect(pick(evs, "intent")).toMatchObject({
      llm_intent: "get_refund",
      final_intent: "get_refund",
      confidence: { level: "medium" },
    });
    expect(text(evs)).toBe("Request a refund.");
    expect(pick(evs, "done")).toMatchObject({ outcome: "ok", escalated: true });
  });

  it("model says out_of_scope → intent event + refusal model_out_of_scope", async () => {
    const t = await createTestTenant(db!);
    const { app } = buildApp(["INTENT: out_of_scope\n---\n"]);
    const evs = await sse(await app.request(ask(t.key, "where is my refund?")));
    expect(names(evs)).toEqual(["meta", "retrieval", "route", "intent", "refusal", "done"]);
    expect(pick(evs, "refusal")).toMatchObject({ reason: "model_out_of_scope" });
  });

  it("primary forced to fail → mock answers with a valid header and the top-1 KB answer", async () => {
    const t = await createTestTenant(db!);
    const { app } = buildApp(["unused"]);
    const evs = await sse(await app.request(ask(t.key, "where is my refund?", { debug: { force_fail: ["ollama"] } })));
    expect(pick(evs, "done")).toMatchObject({
      outcome: "ok_after_fallback",
      fallback_fired: true,
      served_by: { backend_id: "mock" },
    });
    expect(pick(evs, "intent")).toMatchObject({ llm_intent: "track_refund", confidence: { level: "high" } });
    expect(text(evs)).toBe(KB.find((k) => k.id === "kb-06")!.response); // the dense top-1 entry
  });

  it("embedding outage (debug) → lexical fallback, confidence capped at medium", async () => {
    const t = await createTestTenant(db!);
    const { app } = buildApp(["INTENT: track_refund\n---\nCheck Refunds."]);
    const evs = await sse(
      await app.request(ask(t.key, "where is my refund?", { debug: { force_embedding_fail: true } })),
    );
    expect(pick(evs, "retrieval")).toMatchObject({ mode: "lexical_fallback" });
    expect(pick(evs, "intent").confidence.level).toBe("medium");
    expect(await lastRequest(t.id)).toMatchObject({ retrieval_mode: "lexical_fallback", outcome: "ok" });
  });

  it("stream:false returns the documented JSON shape (answer, refusal fields, retrieved, confidence)", async () => {
    const t = await createTestTenant(db!);
    const { app } = buildApp(["INTENT: track_refund\n---\nCheck Refunds."]);
    const ok = SupportResponseSchema.parse(
      await (await app.request(ask(t.key, "where is my refund?", { stream: false }))).json(),
    );
    expect(ok).toMatchObject({
      answer: "Check Refunds.",
      refused: false,
      intent: { final: "track_refund", llm: "track_refund", knn: "track_refund" },
      retrieval_mode: "dense",
      confidence: { level: "high" },
    });
    expect(ok.retrieved).toHaveLength(3);
    const refused = SupportResponseSchema.parse(
      await (await app.request(ask(t.key, "can you order a pizza for me", { stream: false }))).json(),
    );
    expect(refused).toMatchObject({ refused: true, refusal_reason: "low_retrieval_similarity", outcome: "refused" });
    expect(refused.answer).toMatch(/^I'm not confident/);
  });

  it("uncalibrated thresholds → 503 assistant_unavailable before any reservation", async () => {
    const t = await createTestTenant(db!);
    const { app } = buildApp([], { thresholds: { ok: false, missing: ["T_oos for test-embed"] } });
    const res = await app.request(ask(t.key, "where is my refund?"));
    expect(res.status).toBe(503);
    expect(ErrorResponseSchema.parse(await res.json()).error.code).toBe("assistant_unavailable");
    expect(await usedTokens(db!, t.id)).toBe(0);
  });
});

afterAll(async () => {
  await db?.pool.query("DELETE FROM kb_entries WHERE embedding_model = $1", [MODEL]);
  await db?.pool.end();
});

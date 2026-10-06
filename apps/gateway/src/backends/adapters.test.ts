import { readFileSync } from "node:fs";
import { ApiError, ThinkingLevel, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { priceTable } from "../config/pricing.ts";
import { createGeminiBackend } from "./gemini.ts";
import { MOCK_CHAT_REPLY, createMockBackend } from "./mock.ts";
import { createOllamaBackend } from "./ollama.ts";
import { BackendError, type BackendSpec, type GenerateRequest, type StreamChunk } from "./types.ts";

// Adapter contract tests against responses RECORDED from the real providers on 2026-10-06
// (fixtures/gemini-*.json from gemini-3.5-flash, fixtures/ollama-chat.ndjson from gemma4:e2b-mlx). No network.

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
const prices = priceTable("0");

function spec(kind: BackendSpec["kind"], model: string): BackendSpec {
  const id = kind === "gemini" ? "gemini-3.5-flash" : kind;
  return {
    id,
    kind,
    model,
    priority: 0,
    supportsTools: true,
    ttftTimeoutMs: 1000,
    totalTimeoutMs: 5000,
    price: prices[id],
  };
}

function request(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    system: "You are a concise support assistant.",
    messages: [{ role: "user", content: "In one short sentence, how do I track a refund?" }],
    maxOutputTokens: 128,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const c of stream) chunks.push(c);
  return chunks;
}

async function failure(stream: AsyncIterable<StreamChunk>): Promise<BackendError> {
  try {
    await collect(stream);
  } catch (err) {
    if (err instanceof BackendError) return err;
    throw err;
  }
  throw new Error("expected the stream to fail");
}

describe("gemini adapter", () => {
  function geminiWith(chunks: unknown[] | (() => never)) {
    const calls: GenerateContentParameters[] = [];
    const streamFn = async (params: GenerateContentParameters) => {
      calls.push(params);
      if (typeof chunks === "function") chunks();
      return (async function* () {
        for (const c of chunks as GenerateContentResponse[]) yield c;
      })();
    };
    return {
      calls,
      backend: createGeminiBackend(spec("gemini", "gemini-3.5-flash"), {
        apiKey: "k",
        thinkingLevel: "minimal",
        streamFn,
      }),
    };
  }

  it("streams recorded text chunks and maps usageMetadata", async () => {
    const { backend, calls } = geminiWith(JSON.parse(fixture("gemini-text.json")) as unknown[]);
    const chunks = await collect(backend.stream(request()));
    const text = chunks.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
    expect(text.length).toBeGreaterThan(20);
    expect(chunks.at(-1)).toEqual({
      type: "usage",
      promptTokens: 21,
      completionTokens: 35,
      thinkingTokens: 0,
      estimated: false,
    });

    const config = calls[0]?.config;
    expect(config?.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL }); // always explicit
    expect(config?.systemInstruction).toBe("You are a concise support assistant.");
    expect(config?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(config).not.toHaveProperty("temperature"); // Gemini 3: keep the default
    expect(calls[0]?.contents).toEqual([
      { role: "user", parts: [{ text: "In one short sentence, how do I track a refund?" }] },
    ]);
  });

  it("emits recorded function calls as tool_call chunks and passes tools as JSON schema", async () => {
    const { backend, calls } = geminiWith(JSON.parse(fixture("gemini-tool-call.json")) as unknown[]);
    const tools = [{ name: "get_order_status", description: "Look up an order", parameters: { type: "object" } }];
    const chunks = await collect(backend.stream(request({ tools })));
    expect(chunks.filter((c) => c.type !== "usage")).toEqual([
      { type: "tool_call", name: "get_order_status", arguments: { order_id: "12345" } },
    ]);
    expect(calls[0]?.config?.tools).toEqual([
      {
        functionDeclarations: [
          { name: "get_order_status", description: "Look up an order", parametersJsonSchema: { type: "object" } },
        ],
      },
    ]);
  });

  it("uses the escalation thinking level and maps assistant turns to the model role", async () => {
    const { backend, calls } = geminiWith(JSON.parse(fixture("gemini-text.json")) as unknown[]);
    await collect(
      backend.stream(
        request({
          overrides: { thinkingLevel: "low" },
          messages: [
            { role: "user", content: "a" },
            { role: "assistant", content: "b" },
          ],
        }),
      ),
    );
    expect(calls[0]?.config?.thinkingConfig?.thinkingLevel).toBe(ThinkingLevel.LOW);
    expect(calls[0]?.contents).toMatchObject([{ role: "user" }, { role: "model" }]);
  });

  it("never forwards thought parts, but counts thinking tokens", async () => {
    const { backend } = geminiWith([
      { candidates: [{ content: { parts: [{ text: "secret reasoning", thought: true }] } }] },
      {
        candidates: [{ content: { parts: [{ text: "Answer." }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 40 },
      },
    ]);
    const chunks = await collect(backend.stream(request()));
    expect(chunks).toEqual([
      { type: "text", text: "Answer." },
      { type: "usage", promptTokens: 5, completionTokens: 2, thinkingTokens: 40, estimated: false },
    ]);
  });

  it("an empty stream is an upstream_error (usage still reported)", async () => {
    const { backend } = geminiWith([
      {
        candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }],
        usageMetadata: { promptTokenCount: 5, thoughtsTokenCount: 128 },
      },
    ]);
    const chunks: StreamChunk[] = [];
    await expect(
      (async () => {
        for await (const c of backend.stream(request())) chunks.push(c);
      })(),
    ).rejects.toMatchObject({ status: "upstream_error", message: expect.stringMatching(/MAX_TOKENS/) });
    expect(chunks).toEqual([
      { type: "usage", promptTokens: 5, completionTokens: 0, thinkingTokens: 128, estimated: false },
    ]);
  });

  it.each([
    [new ApiError({ status: 429, message: "RESOURCE_EXHAUSTED" }), "rate_limited"],
    [new ApiError({ status: 503, message: "UNAVAILABLE" }), "upstream_error"],
    [new ApiError({ status: 400, message: "INVALID_ARGUMENT" }), "upstream_error"],
    [new TypeError("fetch failed"), "network_error"],
    [Object.assign(new Error("connect"), { code: "ECONNREFUSED" }), "network_error"],
  ])("classifies %s as %s", async (thrown, status) => {
    const { backend } = geminiWith(() => {
      throw thrown;
    });
    expect((await failure(backend.stream(request()))).status).toBe(status);
  });
});

describe("ollama adapter", () => {
  function ollamaWith(respond: (body: Record<string, unknown>) => Response | Promise<Response>) {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return respond(body);
    };
    return {
      bodies,
      backend: createOllamaBackend(spec("ollama", "gemma4:e2b-mlx"), {
        host: "http://ollama.test:11434",
        think: false,
        fetchImpl,
      }),
    };
  }

  it("streams the recorded NDJSON and takes usage from the final chunk", async () => {
    const { backend, bodies } = ollamaWith(() => new Response(fixture("ollama-chat.ndjson")));
    const chunks = await collect(backend.stream(request({ maxOutputTokens: 40 })));
    expect(chunks.filter((c) => c.type === "text").length).toBeGreaterThan(3);
    expect(chunks.at(-1)).toEqual({
      type: "usage",
      promptTokens: 33,
      completionTokens: 13,
      thinkingTokens: 0,
      estimated: false,
    });
    expect(bodies[0]).toMatchObject({
      model: "gemma4:e2b-mlx",
      stream: true,
      think: false,
      keep_alive: "30m",
      options: { num_predict: 40 },
      messages: [
        { role: "system", content: "You are a concise support assistant." },
        { role: "user", content: "In one short sentence, how do I track a refund?" },
      ],
    });
    expect(bodies[0]).not.toHaveProperty("tools");
  });

  it("a missing model (404) is an upstream_error; an unreachable server is a network_error", async () => {
    const missing = ollamaWith(() => new Response(JSON.stringify({ error: "model not found" }), { status: 404 }));
    expect(await failure(missing.backend.stream(request()))).toMatchObject({ status: "upstream_error" });
    const down = ollamaWith(() => Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })));
    expect((await failure(down.backend.stream(request()))).status).toBe("network_error");
  });

  it("passes tools in Ollama's function format", async () => {
    const { backend, bodies } = ollamaWith(() => new Response(fixture("ollama-chat.ndjson")));
    await collect(backend.stream(request({ tools: [{ name: "get_order_status", parameters: { type: "object" } }] })));
    expect(bodies[0]?.["tools"]).toEqual([
      { type: "function", function: { name: "get_order_status", description: "", parameters: { type: "object" } } },
    ]);
  });
});

describe("mock backend", () => {
  afterEach(() => vi.useRealTimers());
  const mockSpec = spec("mock", "mock");

  it("streams the chat reply word by word after the configured latency, with estimated usage", async () => {
    vi.useFakeTimers();
    const backend = createMockBackend(mockSpec, { latencyMs: 300, failRate: 0 });
    const done = collect(backend.stream(request()));
    await vi.runAllTimersAsync();
    const chunks = await done;
    expect(chunks.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("")).toBe(MOCK_CHAT_REPLY);
    expect(chunks.at(-1)).toMatchObject({ type: "usage", estimated: true, thinkingTokens: 0 });
  });

  it("returns the support reply it is given (valid header + top-1 KB answer)", async () => {
    vi.useFakeTimers();
    const reply =
      "INTENT: track_refund\n---\nYou can check the status of your refund in {{Online Company Portal Info}}.";
    const done = collect(
      createMockBackend(mockSpec, { latencyMs: 0, failRate: 0 }).stream(request({ mock: { reply } })),
    );
    await vi.runAllTimersAsync();
    expect((await done).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("")).toBe(reply);
  });

  it("fails on debug.mock_fail or when the random draw is below MOCK_FAIL_RATE", async () => {
    const forced = createMockBackend(mockSpec, { latencyMs: 0, failRate: 0 });
    expect((await failure(forced.stream(request({ mock: { fail: true } })))).status).toBe("upstream_error");
    const unlucky = createMockBackend(mockSpec, { latencyMs: 0, failRate: 0.5, random: () => 0.1 });
    expect((await failure(unlucky.stream(request()))).status).toBe("upstream_error");
  });

  it("honours a per-request latency override and stops on abort", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const backend = createMockBackend(mockSpec, { latencyMs: 0, failRate: 0 });
    const pending = failure(backend.stream(request({ mock: { latencyMs: 20_000 }, signal: controller.signal })));
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    expect((await pending).status).toBe("aborted");
  });
});

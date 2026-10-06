import {
  BackendError,
  estimateTokenCount,
  type Backend,
  type BackendSpec,
  type GenerateRequest,
  type StreamChunk,
} from "./types.ts";

// Mock backend (docs/04 §2): configurable latency to first token, per-word delay, random failure rate and
// per-request debug overrides. It is the last-resort safety net in every profile and the deterministic way
// to demo fallback. For the support endpoint the caller passes `mock.reply` (a valid INTENT header plus the
// top-1 KB answer), so a degraded answer is still grounded. Usage is estimated and the price is 0.

export const MOCK_CHAT_REPLY =
  "[mock] This is a mock response from the gateway's safety-net backend. A real model was not used for this answer.";
const PER_WORD_DELAY_MS = 15;

export type MockOptions = {
  latencyMs: number; // MOCK_LATENCY_MS
  failRate: number; // MOCK_FAIL_RATE, 0..1
  random?: () => number; // injectable for tests
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new BackendError("aborted", "aborted"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new BackendError("aborted", "aborted"));
      },
      { once: true },
    );
  });
}

export function createMockBackend(spec: BackendSpec, options: MockOptions): Backend {
  const random = options.random ?? Math.random;
  return {
    spec,
    async *stream(req: GenerateRequest): AsyncIterable<StreamChunk> {
      await sleep(req.mock?.latencyMs ?? options.latencyMs, req.signal);
      if (req.mock?.fail || random() < options.failRate) {
        throw new BackendError("upstream_error", "mock backend failure (MOCK_FAIL_RATE or debug.mock_fail)");
      }
      const reply = req.mock?.reply ?? MOCK_CHAT_REPLY;
      const words = reply.split(/(?<=\s)/); // keep whitespace attached so the joined text equals `reply`
      for (const [i, word] of words.entries()) {
        if (i > 0) await sleep(PER_WORD_DELAY_MS, req.signal);
        yield { type: "text", text: word };
      }
      const prompt = [req.system ?? "", ...req.messages.map((m) => m.content)].join("\n");
      yield {
        type: "usage",
        promptTokens: estimateTokenCount(prompt),
        completionTokens: estimateTokenCount(reply),
        thinkingTokens: 0,
        estimated: true,
      };
    },
  };
}

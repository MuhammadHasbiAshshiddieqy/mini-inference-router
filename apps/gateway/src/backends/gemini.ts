import {
  ApiError,
  GoogleGenAI,
  ThinkingLevel as GeminiThinkingLevel,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from "@google/genai";
import {
  BackendError,
  type Backend,
  type BackendSpec,
  type GenerateRequest,
  type StreamChunk,
  type ThinkingLevel,
  type UsageChunk,
} from "./types.ts";

// Gemini adapter (docs/04 §2), official @google/genai SDK.
// - `config.thinkingConfig.thinkingLevel` is ALWAYS set: if unset, gemini-3.5-flash defaults to medium and
//   gemini-3-flash-preview to high. Temperature/topP/topK are never set (Google recommends the defaults on Gemini 3).
// - `config.abortSignal` cancels client-side only; already generated tokens may still be billed.
// - Usage comes from `usageMetadata` (last chunk wins); thinking tokens (`thoughtsTokenCount`) are billed as output.
// source: https://ai.google.dev/gemini-api/docs/interactions/whats-new-gemini-3.5 and
// https://googleapis.github.io/js-genai/ (GenerateContentConfig, ThinkingLevel, usage metadata), checked 2026-10-06.

type StreamFn = (params: GenerateContentParameters) => Promise<AsyncGenerator<GenerateContentResponse>>;

export type GeminiOptions = {
  apiKey: string;
  thinkingLevel: ThinkingLevel; // GEMINI_THINKING_LEVEL
  streamFn?: StreamFn; // injectable for tests
};

const LEVELS: Record<ThinkingLevel, GeminiThinkingLevel> = {
  minimal: GeminiThinkingLevel.MINIMAL,
  low: GeminiThinkingLevel.LOW,
  medium: GeminiThinkingLevel.MEDIUM,
  high: GeminiThinkingLevel.HIGH,
};

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const cause = "cause" in err ? (err as { cause?: unknown }).cause : undefined;
  const code = (cause as { code?: unknown } | undefined)?.code ?? (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function classifyGeminiError(err: unknown, signal: AbortSignal): BackendError {
  if (err instanceof BackendError) return err;
  if (signal.aborted) return new BackendError("aborted", "request aborted", { cause: err });
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ApiError) {
    if (err.status === 429) return new BackendError("rate_limited", `gemini 429: ${message}`, { cause: err });
    // 5xx is the provider's problem; a 400 is too, because we validated the request ourselves (docs/04 §1).
    return new BackendError("upstream_error", `gemini ${err.status}: ${message}`, { cause: err });
  }
  const code = errorCode(err);
  if (code && /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_)/.test(code)) {
    return new BackendError("network_error", `gemini network error (${code}): ${message}`, { cause: err });
  }
  if (err instanceof TypeError && /fetch failed/i.test(message)) {
    return new BackendError("network_error", `gemini network error: ${message}`, { cause: err });
  }
  return new BackendError("upstream_error", `gemini: ${message}`, { cause: err });
}

export function createGeminiBackend(spec: BackendSpec, options: GeminiOptions): Backend {
  const call: StreamFn =
    options.streamFn ?? ((params) => new GoogleGenAI({ apiKey: options.apiKey }).models.generateContentStream(params));

  return {
    spec,
    async *stream(req: GenerateRequest): AsyncIterable<StreamChunk> {
      const config: GenerateContentConfig = {
        maxOutputTokens: req.maxOutputTokens,
        thinkingConfig: { thinkingLevel: LEVELS[req.overrides?.thinkingLevel ?? options.thinkingLevel] },
        abortSignal: req.signal,
      };
      if (req.system) config.systemInstruction = req.system;
      if (req.tools?.length) {
        config.tools = [
          {
            functionDeclarations: req.tools.map((t) => ({
              name: t.name,
              ...(t.description ? { description: t.description } : {}),
              ...(t.parameters ? { parametersJsonSchema: t.parameters } : {}),
            })),
          },
        ];
      }
      const contents = req.messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

      let usage: UsageChunk | undefined;
      let produced = false;
      let finishReason: string | undefined;
      try {
        const stream = await call({ model: spec.model, contents, config });
        for await (const chunk of stream) {
          const candidate = chunk.candidates?.[0];
          finishReason = candidate?.finishReason ?? finishReason;
          for (const part of candidate?.content?.parts ?? []) {
            if (part.thought) continue; // never forward thoughts (they are counted via thoughtsTokenCount)
            if (part.text) {
              produced = true;
              yield { type: "text", text: part.text };
            }
            if (part.functionCall?.name) {
              produced = true;
              yield { type: "tool_call", name: part.functionCall.name, arguments: part.functionCall.args ?? {} };
            }
          }
          const meta = chunk.usageMetadata;
          if (meta) {
            usage = {
              type: "usage",
              promptTokens: meta.promptTokenCount ?? 0,
              completionTokens: meta.candidatesTokenCount ?? 0,
              thinkingTokens: meta.thoughtsTokenCount ?? 0,
              estimated: false,
            };
          }
        }
      } catch (err) {
        throw classifyGeminiError(err, req.signal);
      }
      if (!produced) {
        // e.g. all output budget spent on thinking, or a safety block. Report usage so it is still metered.
        if (usage) yield usage;
        throw new BackendError("upstream_error", `gemini returned no content (finishReason=${finishReason ?? "none"})`);
      }
      if (usage) yield usage;
    },
  };
}

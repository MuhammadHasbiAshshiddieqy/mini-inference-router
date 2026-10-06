import { Ollama, type Message, type Tool } from "ollama";
import {
  BackendError,
  type Backend,
  type BackendSpec,
  type GenerateRequest,
  type StreamChunk,
  type UsageChunk,
} from "./types.ts";

// Ollama adapter (docs/04 §2), official `ollama` npm client.
// - `think: false` (OLLAMA_THINK) so the INTENT header comes first; verified on gemma4:e2b-mlx 2026-10-06.
//   If a model still streams a `thinking` field it is never forwarded. Ollama reports one `eval_count`, so any
//   thinking it does is counted as completion tokens.
// - Sampling is left at the model defaults (Gemma: temperature 1.0, top_p 0.95, top_k 64).
// - Abort: one client per attempt with the attempt's signal bound to its fetch, plus the stream's own abort().
// source: https://github.com/ollama/ollama-js (chat, think, keep_alive, AbortableAsyncIterator), checked 2026-10-06.

export type OllamaOptions = {
  host: string;
  think: boolean; // OLLAMA_THINK
  keepAlive?: string;
  fetchImpl?: typeof fetch; // injectable for tests
};

export function classifyOllamaError(err: unknown, signal: AbortSignal): BackendError {
  if (err instanceof BackendError) return err;
  if (signal.aborted) return new BackendError("aborted", "request aborted", { cause: err });
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status_code?: unknown } | null)?.status_code;
  if (typeof status === "number") {
    if (status === 429) return new BackendError("rate_limited", `ollama 429: ${message}`, { cause: err });
    // 404 usually means the model is not pulled: `ollama pull <model>`.
    return new BackendError("upstream_error", `ollama ${status}: ${message}`, { cause: err });
  }
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(`${message} ${String(code ?? "")}`)) {
    return new BackendError("network_error", `ollama unreachable: ${message}`, { cause: err });
  }
  return new BackendError("upstream_error", `ollama: ${message}`, { cause: err });
}

export function createOllamaBackend(spec: BackendSpec, options: OllamaOptions): Backend {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    spec,
    async *stream(req: GenerateRequest): AsyncIterable<StreamChunk> {
      const client = new Ollama({
        host: options.host,
        fetch: (url, init) => fetchImpl(url, { ...init, signal: req.signal }),
      });
      const messages: Message[] = [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ];
      const tools: Tool[] | undefined = req.tools?.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description ?? "", parameters: t.parameters ?? {} },
      }));

      let usage: UsageChunk | undefined;
      let produced = false;
      try {
        const stream = await client.chat({
          model: spec.model,
          messages,
          stream: true,
          think: options.think,
          keep_alive: options.keepAlive ?? "30m",
          options: { num_predict: req.maxOutputTokens },
          ...(tools?.length ? { tools } : {}),
        });
        req.signal.addEventListener("abort", () => stream.abort(), { once: true });
        for await (const part of stream) {
          if (part.message?.content) {
            produced = true;
            yield { type: "text", text: part.message.content };
          }
          for (const call of part.message?.tool_calls ?? []) {
            produced = true;
            yield { type: "tool_call", name: call.function.name, arguments: call.function.arguments };
          }
          if (part.done) {
            usage = {
              type: "usage",
              promptTokens: part.prompt_eval_count ?? 0,
              completionTokens: part.eval_count ?? 0,
              thinkingTokens: 0,
              estimated: false,
            };
          }
        }
      } catch (err) {
        throw classifyOllamaError(err, req.signal);
      }
      if (!produced) {
        if (usage) yield usage;
        throw new BackendError("upstream_error", "ollama returned no content");
      }
      if (usage) yield usage;
    },
  };
}

import type { BackendId, Profile } from "@mir/shared";
import type { BackendSpec } from "../backends/types.ts";
import type { Env } from "./env.ts";
import { priceTable } from "./pricing.ts";

// Profiles (docs/04 §3): which backends exist, in priority order. Backend ids are stable; models come from env.
//   cloud : gemini-3.5-flash → gemini-3-flash → mock   (separate free-tier quota per model; mock = safety net)
//   local : ollama → mock
//   hybrid: gemini-3.5-flash → ollama → mock           (optional, eval/dev)
export const PROFILE_BACKENDS: Record<Profile, readonly BackendId[]> = {
  cloud: ["gemini-3.5-flash", "gemini-3-flash", "mock"],
  local: ["ollama", "mock"],
  hybrid: ["gemini-3.5-flash", "ollama", "mock"],
};

// The mock's delay is per request (debug.mock_latency_ms, up to 20 s), so its timeouts are fixed here:
// a mock latency above 10 s demonstrates a TTFT timeout.
const MOCK_TTFT_TIMEOUT_MS = 10_000;
const MOCK_TOTAL_TIMEOUT_MS = 30_000;

// Owner rule (CLAUDE.md): tool calling only on Gemini >= 3, because 2.5 Flash tool calling proved unreliable.
// Derived from the model id, so pointing GEMINI_*_MODEL at a 2.x model can never enable tools by accident.
export function geminiSupportsTools(model: string): boolean {
  const match = /gemini-(\d+)(?:\.\d+)?/.exec(model);
  return match !== null && Number(match[1]) >= 3;
}

export function backendSpecs(env: Env): BackendSpec[] {
  const prices = priceTable(env.LOCAL_COST_PER_1M);
  const gemini = (id: BackendId, model: string) => ({
    id,
    kind: "gemini" as const,
    model,
    supportsTools: geminiSupportsTools(model),
    ttftTimeoutMs: env.GEMINI_TTFT_TIMEOUT_MS,
    totalTimeoutMs: env.GEMINI_TOTAL_TIMEOUT_MS,
    price: prices[id],
  });
  const all: Record<BackendId, Omit<BackendSpec, "priority">> = {
    "gemini-3.5-flash": gemini("gemini-3.5-flash", env.GEMINI_PRIMARY_MODEL),
    "gemini-3-flash": gemini("gemini-3-flash", env.GEMINI_FALLBACK_MODEL),
    ollama: {
      id: "ollama",
      kind: "ollama",
      model: env.OLLAMA_CHAT_MODEL,
      supportsTools: env.OLLAMA_SUPPORTS_TOOLS,
      ttftTimeoutMs: env.OLLAMA_TTFT_TIMEOUT_MS,
      totalTimeoutMs: env.OLLAMA_TOTAL_TIMEOUT_MS,
      price: prices.ollama,
    },
    mock: {
      id: "mock",
      kind: "mock",
      model: "mock",
      supportsTools: false,
      ttftTimeoutMs: MOCK_TTFT_TIMEOUT_MS,
      totalTimeoutMs: MOCK_TOTAL_TIMEOUT_MS,
      price: prices.mock,
    },
  };
  return PROFILE_BACKENDS[env.PROFILE].map((id, index) => ({ ...all[id], priority: index }));
}

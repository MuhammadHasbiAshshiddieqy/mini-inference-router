import type { BackendId } from "@mir/shared";

// USD per 1M tokens (docs/04 §7). Thinking tokens are billed as output. We run on the free tier, so every
// cost is a list-price equivalent ("est." in the UI). Money is never a float: prices are decimal strings and
// costs are computed in integer units of 1e-8 USD, matching numeric(12,8) in the database.

export type Price = { inputPer1M: string; outputPer1M: string; source: string };

const GEMINI_PRICING_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing, standard paid tier, checked 2026-10-06";

export function priceTable(localCostPer1M: string): Record<BackendId, Price> {
  return {
    "gemini-3.5-flash": { inputPer1M: "1.50", outputPer1M: "9.00", source: GEMINI_PRICING_SOURCE },
    "gemini-3-flash": { inputPer1M: "0.50", outputPer1M: "3.00", source: GEMINI_PRICING_SOURCE },
    ollama: {
      inputPer1M: localCostPer1M,
      outputPer1M: localCostPer1M,
      source: "LOCAL_COST_PER_1M (optional hardware/electricity estimate; 0 = free)",
    },
    mock: { inputPer1M: "0", outputPer1M: "0", source: "mock backend, never billed" },
  };
}

export type TokenUsage = { promptTokens: number; completionTokens: number; thinkingTokens: number };

const MICRO = 1_000_000n; // prices are parsed to micro-dollars per 1M tokens
const UNITS_PER_USD = 100_000_000n; // 1e-8 USD

function toMicro(decimal: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(decimal);
  if (!match) throw new Error(`invalid price "${decimal}"`);
  return BigInt(match[1] ?? "0") * MICRO + BigInt((match[2] ?? "").padEnd(6, "0"));
}

function toUnits(usd: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(usd);
  if (!match) throw new Error(`invalid USD amount "${usd}"`);
  return BigInt(match[1] ?? "0") * UNITS_PER_USD + BigInt((match[2] ?? "").padEnd(8, "0"));
}

function formatUnits(units: bigint): string {
  const whole = units / UNITS_PER_USD;
  const frac = (units % UNITS_PER_USD).toString().padStart(8, "0");
  return `${whole}.${frac}`;
}

function tokens(n: number, name: string): bigint {
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${n}`);
  return BigInt(n);
}

// Cost of one attempt: (prompt × input + (completion + thinking) × output) / 1e6, rounded half-up to 1e-8 USD.
export function costUsd(price: Price, usage: TokenUsage): string {
  const microTimesTokens =
    tokens(usage.promptTokens, "promptTokens") * toMicro(price.inputPer1M) +
    (tokens(usage.completionTokens, "completionTokens") + tokens(usage.thinkingTokens, "thinkingTokens")) *
      toMicro(price.outputPer1M);
  // micro-USD per 1M tokens × tokens = 1e-12 USD; 1e-8 USD units = that / 1e4.
  return formatUnits((microTimesTokens + 5_000n) / 10_000n);
}

// Request cost = sum over attempts (docs/04 §7).
export function sumUsd(amounts: string[]): string {
  return formatUnits(amounts.reduce((sum, a) => sum + toUnits(a), 0n));
}

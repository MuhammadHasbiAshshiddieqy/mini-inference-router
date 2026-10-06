import { describe, expect, it } from "vitest";
import { costUsd, priceTable, sumUsd } from "./pricing.ts";

const prices = priceTable("0");
const usage = (promptTokens: number, completionTokens: number, thinkingTokens = 0) => ({
  promptTokens,
  completionTokens,
  thinkingTokens,
});

describe("pricing", () => {
  it("prices one million tokens at the list price", () => {
    expect(costUsd(prices["gemini-3.5-flash"], usage(1_000_000, 0))).toBe("1.50000000");
    expect(costUsd(prices["gemini-3.5-flash"], usage(0, 1_000_000))).toBe("9.00000000");
  });

  it("bills thinking tokens as output", () => {
    // 812 × 1.50 + (140 + 60) × 9.00 = 1218 + 1800 = 3018 µ$ → 0.003018 USD
    expect(costUsd(prices["gemini-3.5-flash"], usage(812, 140, 60))).toBe("0.00301800");
    expect(costUsd(prices["gemini-3-flash"], usage(812, 140, 60))).toBe("0.00100600");
  });

  it("rounds half-up to 1e-8 USD without float drift", () => {
    // 1 token × 0.50 / 1e6 = 0.0000005 → 0.00000050; 3 tokens × 1.50 = 0.0000045 → 0.00000450
    expect(costUsd(prices["gemini-3-flash"], usage(1, 0))).toBe("0.00000050");
    expect(costUsd({ inputPer1M: "0.000001", outputPer1M: "0", source: "t" }, usage(5, 0))).toBe("0.00000000");
    expect(costUsd({ inputPer1M: "0.000001", outputPer1M: "0", source: "t" }, usage(5_000, 0))).toBe("0.00000001");
  });

  it("mock is free and local cost is configurable", () => {
    expect(costUsd(prices.mock, usage(10_000, 10_000))).toBe("0.00000000");
    expect(costUsd(priceTable("0.25").ollama, usage(1_000_000, 1_000_000))).toBe("0.50000000");
  });

  it("sums attempt costs exactly", () => {
    expect(sumUsd(["0.10000000", "0.20000000"])).toBe("0.30000000"); // 0.1 + 0.2 in floats is 0.30000000000000004
    expect(sumUsd([])).toBe("0.00000000");
  });

  it("rejects invalid token counts", () => {
    expect(() => costUsd(prices.mock, usage(-1, 0))).toThrow(/non-negative integer/);
    expect(() => costUsd(prices.mock, usage(1.5, 0))).toThrow(/non-negative integer/);
  });
});

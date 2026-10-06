import { describe, expect, it } from "vitest";
import { fmtDeltaPp, goldRank, isConfusable, isHard, mean, mrr, pct, rate } from "./eval-metrics.ts";

describe("eval metrics", () => {
  it("gold rank within k", () => {
    expect(goldRank(["a", "b", "gold", "gold"], "gold", 5)).toBe(3);
    expect(goldRank(["a", "b", "gold"], "gold", 2)).toBeNull();
  });

  it("MRR, rates, means and nearest-rank percentiles", () => {
    expect(mrr([1, 2, null, 4])).toBeCloseTo((1 + 0.5 + 0 + 0.25) / 4);
    expect(rate([true, false, true, true])).toBe(0.75);
    expect(rate([])).toBeNull();
    expect(mean([1, 2, 3])).toBe(2);
    const xs = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    expect(pct(xs, 0.5)).toBe(10);
    expect(pct(xs, 0.95)).toBe(19);
    expect(pct([7], 0.95)).toBe(7);
  });

  it("hard flags and confusable intents", () => {
    expect(isHard("BLQZ")).toBe(true);
    expect(isHard("BEL")).toBe(false); // E (abbreviations) is not a hard flag for the retrieval breakdown
    expect(isConfusable("track_refund")).toBe(true);
    expect(isConfusable("cancel_order")).toBe(false);
  });

  it("formats deltas in percentage points", () => {
    expect(fmtDeltaPp(0.9, 0.93)).toBe("+3.0 pp");
    expect(fmtDeltaPp(0.9, 0.85)).toBe("-5.0 pp");
  });
});

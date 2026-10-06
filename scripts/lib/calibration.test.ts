import { describe, expect, it } from "vitest";
import { percentile, recallAbove, recallBelow, thresholdForRecall } from "./calibration.ts";

describe("calibration", () => {
  const scores = Array.from({ length: 100 }, (_, i) => 0.5 + i / 200); // 0.500 … 0.995

  it("picks the largest threshold that keeps the required in-domain recall", () => {
    const t = thresholdForRecall(scores, 0.98);
    expect(t).toBe(0.51); // the 3rd lowest: 2 of 100 queries fall below
    expect(recallAbove(scores, t)).toBeGreaterThanOrEqual(0.98);
    expect(recallAbove(scores, t + 0.001)).toBeLessThan(0.98);
  });

  it("rounds down so the boundary query still passes", () => {
    expect(thresholdForRecall([0.61239, 0.7, 0.8], 1)).toBe(0.612);
  });

  it("percentile and OOS recall", () => {
    expect(percentile(scores, 0.3)).toBe(0.65);
    expect(recallBelow([0.2, 0.4, 0.6], 0.5)).toBeCloseTo(2 / 3);
  });
});

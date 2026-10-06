// Threshold calibration math (docs/05 §7), pure.

// The largest threshold t such that at least `minRecall` of in-domain scores are >= t (i.e. at most
// floor((1 - minRecall) · n) in-domain queries are pre-refused). Rounded DOWN to 3 decimals so the
// boundary query itself still passes.
export function thresholdForRecall(inDomain: readonly number[], minRecall: number): number {
  if (inDomain.length === 0) throw new Error("no in-domain scores");
  const sorted = [...inDomain].sort((a, b) => a - b);
  const allowedBelow = Math.floor((1 - minRecall) * sorted.length + 1e-9);
  return Math.floor(sorted[allowedBelow]! * 1000) / 1000;
}

// The p-th percentile (nearest rank, lower), e.g. p = 0.3 for T_high.
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export const recallAbove = (scores: readonly number[], t: number) =>
  scores.filter((s) => s >= t).length / scores.length;
export const recallBelow = (scores: readonly number[], t: number) => scores.filter((s) => s < t).length / scores.length;

import type { Intent, RetrievalMode } from "@mir/shared";

// Retrieval signals and kNN intent (docs/05 §3), pure.
// Ranking and gating are separate (docs/05 §2.1): whatever ordered the candidates (cosine or RRF), the
// gate and the votes use the calibrated DENSE cosine. Only in lexical fallback (no embedding) do they use
// trigram similarity, which has its own threshold.

export type Candidate = { intent: Intent; dense_sim: number | null; trgm_sim: number | null };

export type RetrievalSignals = {
  mode: RetrievalMode;
  top1Similarity: number; // max dense cosine among candidates (trigram top-1 in lexical fallback)
  knnIntent: Intent;
  voteShare: number; // weight(knn_intent) / total weight, 0..1
};

export function retrievalSignals(mode: RetrievalMode, candidates: readonly Candidate[]): RetrievalSignals {
  if (candidates.length === 0) throw new Error("retrievalSignals needs at least one candidate");
  const score = (c: Candidate) => (mode === "lexical_fallback" ? (c.trgm_sim ?? 0) : (c.dense_sim ?? 0));

  const top1Similarity = Math.max(...candidates.map(score));
  const weights = new Map<Intent, number>();
  for (const c of candidates) weights.set(c.intent, (weights.get(c.intent) ?? 0) + Math.max(0, score(c)));
  const total = [...weights.values()].reduce((a, b) => a + b, 0);

  // Highest weight wins; ties go to the intent that appears first in rank order.
  let knnIntent = candidates[0]!.intent;
  for (const c of candidates) {
    if ((weights.get(c.intent) ?? 0) > (weights.get(knnIntent) ?? 0)) knnIntent = c.intent;
  }
  return { mode, top1Similarity, knnIntent, voteShare: total > 0 ? (weights.get(knnIntent) ?? 0) / total : 0 };
}

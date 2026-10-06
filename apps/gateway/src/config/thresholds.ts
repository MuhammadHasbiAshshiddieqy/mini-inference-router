import { z } from "zod";
import raw from "../../../../data/thresholds.json" with { type: "json" };
import type { Thresholds } from "../assistant/confidence.ts";
import type { Env } from "./env.ts";

// Refusal thresholds (docs/05 §7), written by `pnpm calibrate` to data/thresholds.json and committed.
// Dense thresholds differ per embedding model, so they are keyed by model; the trigram threshold is
// model-independent (key "trigram"). Env vars CONFIDENCE_* override the file.
// Imported (not read from disk) so serverless bundlers include the file.

const Calibration = z.object({ n_in_domain: z.number(), n_oos: z.number(), computed_at: z.string() }).passthrough();
const DenseEntry = z
  .object({ T_oos: z.number(), T_high: z.number(), calibration: Calibration.optional() })
  .passthrough();
const TrigramEntry = z.object({ T_trgm_oos: z.number(), calibration: Calibration.optional() }).passthrough();
const FileSchema = z.record(z.string(), z.unknown());

export type ThresholdsResult = { ok: true; thresholds: Thresholds } | { ok: false; missing: string[] };

export function resolveThresholds(env: Env, embeddingModel: string, file: unknown = raw): ThresholdsResult {
  const entries = FileSchema.parse(file);
  const dense = DenseEntry.safeParse(entries[embeddingModel]);
  const trigram = TrigramEntry.safeParse(entries["trigram"]);
  const T_oos = env.CONFIDENCE_T_OOS ?? (dense.success ? dense.data.T_oos : undefined);
  const T_high = env.CONFIDENCE_T_HIGH ?? (dense.success ? dense.data.T_high : undefined);
  const T_trgm_oos = env.CONFIDENCE_T_TRGM_OOS ?? (trigram.success ? trigram.data.T_trgm_oos : undefined);
  if (T_oos === undefined || T_high === undefined || T_trgm_oos === undefined) {
    const missing = [
      ...(T_oos === undefined ? [`T_oos for ${embeddingModel}`] : []),
      ...(T_high === undefined ? [`T_high for ${embeddingModel}`] : []),
      ...(T_trgm_oos === undefined ? ["T_trgm_oos (trigram)"] : []),
    ];
    return { ok: false, missing };
  }
  return { ok: true, thresholds: { T_oos, T_high, T_trgm_oos } };
}

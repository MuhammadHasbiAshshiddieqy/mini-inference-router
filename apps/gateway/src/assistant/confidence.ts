import type { ConfidenceLevel, RefusalReason, SupportLabel } from "@mir/shared";
import type { RetrievalSignals } from "./intent.ts";

// Confidence and refusal (docs/05 §6), pure. Thresholds come from calibration on the dev split (§7):
//   T_oos      dense pre-gate          T_high  dense "strong evidence" level
//   T_trgm_oos trigram pre-gate, used only in lexical fallback (embedding unavailable)
// In lexical fallback any `high` is capped at `medium`: lexical evidence is weaker.

export type Thresholds = { T_oos: number; T_high: number; T_trgm_oos: number };

export const REFUSAL_MESSAGE =
  "I'm not confident I can answer that correctly. I can connect you with a human agent. Could you rephrase or share more details about your order or account?";

export type Decision =
  | { action: "answer"; level: ConfidenceLevel; finalIntent: SupportLabel }
  | { action: "refuse"; level: "low"; reason: RefusalReason; finalIntent: SupportLabel | null }
  | { action: "escalate"; why: "intent_disagreement" | "invalid_output" };

// Before any LLM call: is the closest KB entry close enough to be in domain at all?
export function preGate(signals: RetrievalSignals, t: Thresholds): Decision | undefined {
  const threshold = signals.mode === "lexical_fallback" ? t.T_trgm_oos : t.T_oos;
  if (signals.top1Similarity < threshold) {
    return { action: "refuse", level: "low", reason: "low_retrieval_similarity", finalIntent: null };
  }
  return undefined;
}

const cap = (level: ConfidenceLevel, signals: RetrievalSignals): ConfidenceLevel =>
  signals.mode === "lexical_fallback" && level === "high" ? "medium" : level;

// Once the model's INTENT header is parsed.
export function decideOnHeader(
  llmIntent: SupportLabel,
  signals: RetrievalSignals,
  escalated: boolean,
  t: Thresholds,
): Decision {
  if (llmIntent === "out_of_scope") {
    return { action: "refuse", level: "low", reason: "model_out_of_scope", finalIntent: "out_of_scope" };
  }
  if (llmIntent === signals.knnIntent) {
    return {
      action: "answer",
      level: cap(signals.voteShare >= 0.6 ? "high" : "medium", signals),
      finalIntent: llmIntent,
    };
  }
  if (!escalated) return { action: "escalate", why: "intent_disagreement" };
  // Still disagreeing after one escalation: refuse only against strong, concentrated dense evidence.
  const strong = signals.mode !== "lexical_fallback" && signals.top1Similarity >= t.T_high && signals.voteShare >= 0.8;
  if (strong) return { action: "refuse", level: "low", reason: "intent_disagreement", finalIntent: llmIntent };
  return { action: "answer", level: "medium", finalIntent: llmIntent };
}

// The model's output could not be parsed.
export function decideOnInvalidOutput(escalated: boolean): Decision {
  return escalated
    ? { action: "refuse", level: "low", reason: "unusable_model_output", finalIntent: null }
    : { action: "escalate", why: "invalid_output" };
}

// Reported for transparency, never used for decisions:
// 0.5·vote_share + 0.3·clamp((top1 − T)/(1 − T)) + 0.2·agree, with T = T_oos (or T_trgm_oos in lexical fallback).
export function confidenceScore(signals: RetrievalSignals, agree: boolean, t: Thresholds): number {
  const threshold = signals.mode === "lexical_fallback" ? t.T_trgm_oos : t.T_oos;
  const margin = threshold >= 1 ? 0 : Math.min(1, Math.max(0, (signals.top1Similarity - threshold) / (1 - threshold)));
  return Math.round((0.5 * signals.voteShare + 0.3 * margin + 0.2 * (agree ? 1 : 0)) * 1000) / 1000;
}

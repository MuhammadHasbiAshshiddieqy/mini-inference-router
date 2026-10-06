// Evaluation math (docs/07), pure.

export const HARD_FLAGS = ["Z", "Q", "K", "W"] as const; // docs/07 §2b: typos, colloquial, keyword-only, offensive
export const CONFUSABLE_GROUPS: readonly (readonly string[])[] = [
  ["get_refund", "track_refund", "check_refund_policy"],
  ["check_invoice", "get_invoice"],
  ["contact_customer_service", "contact_human_agent"],
  ["change_shipping_address", "set_up_shipping_address"],
  ["create_account", "registration_problems"],
  ["delivery_options", "delivery_period"],
];

export const isHard = (flags: string | null | undefined) => HARD_FLAGS.some((f) => (flags ?? "").includes(f));
export const isConfusable = (intent: string) => CONFUSABLE_GROUPS.some((g) => g.includes(intent));

// Rank (1-based) of the first retrieved entry whose intent is the gold intent, or null.
export function goldRank(retrievedIntents: readonly string[], gold: string, k: number): number | null {
  const i = retrievedIntents.slice(0, k).indexOf(gold);
  return i === -1 ? null : i + 1;
}

export const rate = (xs: readonly boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : null);
export const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Nearest-rank percentile (p in 0..1).
export function pct(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

export function mrr(ranks: readonly (number | null)[]): number | null {
  return ranks.length ? ranks.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / ranks.length : null;
}

export const cosine = (a: readonly number[], b: readonly number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

// Formatting helpers for the markdown report.
export const fmtPct = (x: number | null | undefined) =>
  x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`;
export const fmtNum = (x: number | null | undefined, d = 3) => (x === null || x === undefined ? "—" : x.toFixed(d));
export function fmtDeltaPp(a: number | null | undefined, b: number | null | undefined): string {
  if (a == null || b == null) return "—";
  const d = (b - a) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)} pp`;
}

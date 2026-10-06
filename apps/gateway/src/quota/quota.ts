import type { QuotaState } from "@mir/shared";
import type { Logger } from "pino";
import { AppError } from "../http/errors.ts";

// Token-budget quota with reservation + reconcile (docs/03 §5).
// `used_tokens` = consumed + currently reserved. Reserving is one atomic conditional UPDATE, so concurrent
// requests can never overshoot the budget, and any database error rejects the request (fail closed).

export type Queryable = {
  query<R extends object>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
};

type QuotaRow = { quota_tokens: string; used_tokens: string };

function toState(row: QuotaRow): QuotaState {
  const limit = Number(row.quota_tokens);
  const used = Number(row.used_tokens);
  return { limit, used, remaining: Math.max(0, limit - used) };
}

// Rough prompt-size estimate used only for the reservation (≈ 4 chars per token). Reconcile corrects it.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function reserveTokens(db: Queryable, tenantId: string, tokens: number): Promise<QuotaState> {
  if (!Number.isInteger(tokens) || tokens <= 0)
    throw new Error(`reservation must be a positive integer, got ${tokens}`);
  let result: { rows: QuotaRow[] };
  try {
    result = await db.query<QuotaRow>(
      `UPDATE tenants SET used_tokens = used_tokens + $2
       WHERE id = $1 AND enabled AND used_tokens + $2 <= quota_tokens
       RETURNING quota_tokens, used_tokens`,
      [tenantId, tokens],
    );
  } catch (err) {
    throw new AppError("quota_unavailable", 503, "Quota store unavailable; request rejected (fail closed)", {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  const row = result.rows[0];
  if (row) return toState(row);

  // Not enough budget. Read the current state for a useful error; if even that fails, still reject.
  let current: QuotaState | undefined;
  try {
    const now = await db.query<QuotaRow>("SELECT quota_tokens, used_tokens FROM tenants WHERE id = $1", [tenantId]);
    current = now.rows[0] ? toState(now.rows[0]) : undefined;
  } catch {
    current = undefined; // the 429 below is still correct; details are best-effort
  }
  throw new AppError("quota_exceeded", 429, "Token quota exceeded for this tenant", {
    ...(current ?? {}),
    requested: tokens,
  });
}

// Replaces the reservation with what was actually consumed (sum over all attempts, failed ones included).
// Runs in `finally`. On failure it logs and keeps the reservation: never refund on uncertainty.
export async function reconcileTokens(
  db: Queryable,
  log: Logger,
  tenantId: string,
  reserved: number,
  actual: number,
): Promise<QuotaState | undefined> {
  try {
    const result = await db.query<QuotaRow>(
      `UPDATE tenants SET used_tokens = GREATEST(0, used_tokens - $2 + $3)
       WHERE id = $1 RETURNING quota_tokens, used_tokens`,
      [tenantId, reserved, actual],
    );
    return result.rows[0] ? toState(result.rows[0]) : undefined;
  } catch (err) {
    log.error({ err, tenant_id: tenantId, reserved, actual }, "quota reconcile failed; reservation kept");
    return undefined;
  }
}

import type { QuotaState, RequestRow, RouteAttemptRow, TenantUsage } from "@mir/shared";
import type { Queryable } from "../quota/quota.ts";

// Read side of metering: usage per tenant and request inspection (docs/03 §3, docs/06).

type UsageRow = {
  tenant_id: string;
  requests: string;
  total_tokens: string;
  cost_usd: string;
  fallback_count: string;
  last_request_at: Date | null;
};
type OutcomeRow = { tenant_id: string; outcome: string; n: string };
type TenantRow = { id: string; name: string; enabled: boolean; quota_tokens: string; used_tokens: string };

export type TenantUsageView = { id: string; name: string; enabled: boolean; quota: QuotaState; usage: TenantUsage };

const EMPTY_USAGE: TenantUsage = {
  requests: 0,
  total_tokens: 0,
  cost_usd: 0,
  fallback_count: 0,
  outcomes: {},
  last_request_at: null,
};

// One query for totals, one for the outcome breakdown; `tenantId` narrows both to one tenant.
export async function tenantUsage(db: Queryable, tenantId?: string): Promise<TenantUsageView[]> {
  const filter = tenantId ? "WHERE t.id = $1" : "";
  const params = tenantId ? [tenantId] : [];
  const [tenants, totals, outcomes] = await Promise.all([
    db.query<TenantRow>(
      `SELECT t.id, t.name, t.enabled, t.quota_tokens, t.used_tokens FROM tenants t ${filter} ORDER BY t.id`,
      params,
    ),
    db.query<UsageRow>(
      `SELECT t.id AS tenant_id, count(r.id) AS requests, coalesce(sum(r.total_tokens), 0) AS total_tokens,
              coalesce(sum(r.cost_usd), 0) AS cost_usd, count(r.id) FILTER (WHERE r.fallback_fired) AS fallback_count,
              max(r.created_at) AS last_request_at
       FROM tenants t LEFT JOIN requests r ON r.tenant_id = t.id ${filter} GROUP BY t.id`,
      params,
    ),
    db.query<OutcomeRow>(
      `SELECT r.tenant_id, r.outcome, count(*) AS n FROM requests r JOIN tenants t ON t.id = r.tenant_id ${filter}
       GROUP BY r.tenant_id, r.outcome`,
      params,
    ),
  ]);

  return tenants.rows.map((t) => {
    const total = totals.rows.find((r) => r.tenant_id === t.id);
    const limit = Number(t.quota_tokens);
    const used = Number(t.used_tokens);
    const usage: TenantUsage = total
      ? {
          requests: Number(total.requests),
          total_tokens: Number(total.total_tokens),
          cost_usd: Number(total.cost_usd),
          fallback_count: Number(total.fallback_count),
          outcomes: Object.fromEntries(
            outcomes.rows.filter((o) => o.tenant_id === t.id).map((o) => [o.outcome, Number(o.n)]),
          ),
          last_request_at: total.last_request_at?.toISOString() ?? null,
        }
      : EMPTY_USAGE;
    return {
      id: t.id,
      name: t.name,
      enabled: t.enabled,
      quota: { limit, used, remaining: Math.max(0, limit - used) },
      usage,
    };
  });
}

const REQUEST_COLUMNS = `id, tenant_id, endpoint, profile, outcome, served_backend_id, served_model, fallback_fired, escalated,
  attempts_count, prompt_tokens, completion_tokens, thinking_tokens, total_tokens, tokens_estimated, cost_usd::text AS cost_usd,
  latency_ms, ttft_ms, intent, confidence_level, confidence_score, retrieved_ids, retrieval_mode, error_code, created_at`;

type DbRequestRow = Omit<RequestRow, "created_at"> & { created_at: Date };
type DbAttemptRow = Omit<RouteAttemptRow, "started_at"> & { started_at: Date };

const toRequestRow = (r: DbRequestRow): RequestRow => ({ ...r, created_at: r.created_at.toISOString() });

export async function listRequests(
  db: Queryable,
  filter: { tenant?: string | undefined; outcome?: string | undefined; limit: number },
): Promise<RequestRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.tenant) where.push(`tenant_id = $${params.push(filter.tenant)}`);
  if (filter.outcome) where.push(`outcome = $${params.push(filter.outcome)}`);
  const result = await db.query<DbRequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM requests ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY created_at DESC, id DESC LIMIT $${params.push(filter.limit)}`,
    params,
  );
  return result.rows.map(toRequestRow);
}

export async function getRequestDetail(
  db: Queryable,
  id: string,
): Promise<{ request: RequestRow; attempts: RouteAttemptRow[] } | undefined> {
  const request = (await db.query<DbRequestRow>(`SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = $1`, [id])).rows[0];
  if (!request) return undefined;
  const attempts = await db.query<DbAttemptRow>(
    `SELECT attempt_no, backend_id, model, reason, status, error_detail, prompt_tokens, completion_tokens, thinking_tokens,
            cost_usd::text AS cost_usd, latency_ms, ttft_ms, started_at
     FROM route_attempts WHERE request_id = $1 ORDER BY attempt_no`,
    [id],
  );
  return {
    request: toRequestRow(request),
    attempts: attempts.rows.map((a) => ({ ...a, started_at: a.started_at.toISOString() })),
  };
}

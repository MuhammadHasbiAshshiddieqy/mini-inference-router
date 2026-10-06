import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  type DebugOptions,
  type Endpoint,
  type Profile,
  type QuotaState,
} from "@mir/shared";
import type { Context } from "hono";
import type { z } from "zod";
import {
  finalizeRequest,
  insertRequest,
  recordRejectedRequest,
  type RequestFinal,
  type RequestStart,
} from "../metering/requests.ts";
import { reconcileTokens, reserveTokens, type Queryable } from "../quota/quota.ts";
import { requireTenant } from "./auth.ts";
import { AppError } from "./errors.ts";
import type { AppEnv, Tenant } from "./types.ts";

// The common front half of every LLM endpoint (docs/03 §2 steps 2–4, after auth):
// parse + validate the body → tenant policy (output cap, debug) → reserve quota → insert the `in_progress` row.
// Rejections from a known tenant are metered as one `requests` row; nothing reaches a backend until this
// returns, so an unavailable database means no LLM call (fail closed).

type BaseBody = { max_output_tokens?: number | undefined; debug?: DebugOptions | undefined };

export type Admission<T> = {
  start: RequestStart;
  tenant: Tenant;
  body: T;
  maxOutputTokens: number;
  reservedTokens: number;
  quota: QuotaState;
  startedAt: number; // performance.now() at admission, for latency
};

export type AdmitOptions<T extends BaseBody> = {
  db: Queryable;
  profile: Profile;
  endpoint: Endpoint;
  schema: z.ZodType<T>;
  // Prompt-size estimate for the reservation (e.g. messages, or message + KB context for support).
  estimatePromptTokens: (body: T) => number;
};

function invalid(message: string, details?: unknown): AppError {
  return new AppError("invalid_request", 400, message, details);
}

export async function admit<T extends BaseBody>(c: Context<AppEnv>, opts: AdmitOptions<T>): Promise<Admission<T>> {
  const startedAt = performance.now();
  const tenant = requireTenant(c);
  const log = c.get("logger");
  const start: RequestStart = {
    id: c.get("requestId"),
    tenantId: tenant.id,
    endpoint: opts.endpoint,
    profile: opts.profile,
  };

  let body: T;
  try {
    body = await parseBody(c, opts.schema, tenant);
  } catch (err) {
    if (err instanceof AppError) await recordRejectedRequest(opts.db, log, start, "invalid_request", err.code);
    throw err;
  }

  const maxOutputTokens = body.max_output_tokens ?? Math.min(DEFAULT_MAX_OUTPUT_TOKENS, tenant.maxOutputTokens);
  const reservedTokens = opts.estimatePromptTokens(body) + maxOutputTokens;

  let quota: QuotaState;
  try {
    quota = await reserveTokens(opts.db, tenant.id, reservedTokens);
  } catch (err) {
    if (err instanceof AppError && err.code === "quota_exceeded") {
      await recordRejectedRequest(opts.db, log, start, "quota_exceeded", err.code);
    }
    throw err; // quota_unavailable: the database is down, so no row can be written either
  }

  try {
    await insertRequest(opts.db, start);
  } catch (err) {
    await reconcileTokens(opts.db, log, tenant.id, reservedTokens, 0);
    log.error({ err }, "failed to insert request row");
    throw new AppError("quota_unavailable", 503, "Metering store unavailable; request rejected (fail closed)");
  }

  log.info({ endpoint: opts.endpoint, reserved_tokens: reservedTokens, remaining: quota.remaining }, "admitted");
  return { start, tenant, body, maxOutputTokens, reservedTokens, quota, startedAt };
}

// The back half: replace the reservation with the tokens actually consumed (all attempts), then finalize the
// `requests` row. Called before `done` is sent (docs/12 §1), and from `finally` on error paths.
export async function settle<T>(
  db: Queryable,
  c: Context<AppEnv>,
  admission: Admission<T>,
  final: Omit<RequestFinal, "latencyMs">,
): Promise<QuotaState> {
  const log = c.get("logger");
  const quota = await reconcileTokens(db, log, admission.tenant.id, admission.reservedTokens, final.totalTokens);
  const latencyMs = Math.round(performance.now() - admission.startedAt);
  try {
    await finalizeRequest(db, admission.start.id, { ...final, latencyMs });
  } catch (err) {
    log.error({ err, outcome: final.outcome }, "failed to finalize request row");
  }
  // If reconcile failed the reservation is kept; report the last known state conservatively.
  return quota ?? admission.quota;
}

async function parseBody<T extends BaseBody>(c: Context<AppEnv>, schema: z.ZodType<T>, tenant: Tenant): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw invalid("Request body is not valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw invalid(
      "Request body failed validation",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const body = parsed.data;
  if (body.max_output_tokens !== undefined && body.max_output_tokens > tenant.maxOutputTokens) {
    throw invalid(`max_output_tokens exceeds this tenant's cap of ${tenant.maxOutputTokens}`, {
      max_output_tokens: tenant.maxOutputTokens,
    });
  }
  if (body.debug !== undefined && !tenant.allowDebug) {
    throw new AppError("debug_not_allowed", 403, "Debug options are not allowed for this tenant");
  }
  return body;
}

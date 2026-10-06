import type { BackendId } from "@mir/shared";
import type { BackendSpec } from "../backends/types.ts";
import { AppError } from "../http/errors.ts";

// Routing rules (docs/04 §4), a pure function. Applied in order; every exclusion is recorded in `decisions`
// (returned in the `done` event and logged):
//   1. tenant policy  — keep only tenant.allowed_backends          (none left → 403 no_allowed_backend)
//   2. capability     — if the request has tools, keep supportsTools (none left → 422 tools_unsupported)
//   3. priority       — cheapest adequate real model first, then the independent-quota fallback, then mock.
// The circuit breaker (rule 4) is P2 and not built; per-request fallback already covers failures.

export type PlanInput = {
  profileBackends: readonly BackendSpec[];
  allowedBackends: readonly BackendId[];
  hasTools: boolean;
};

export type Plan = { candidates: BackendSpec[]; decisions: string[] };

export function plan({ profileBackends, allowedBackends, hasTools }: PlanInput): Plan {
  const decisions: string[] = [];

  const allowed = profileBackends.filter((b) => {
    const ok = allowedBackends.includes(b.id);
    if (!ok) decisions.push(`excluded ${b.id}: not in tenant allowed_backends`);
    return ok;
  });
  if (allowed.length === 0) {
    throw new AppError("no_allowed_backend", 403, "None of this profile's backends is allowed for this tenant", {
      profile_backends: profileBackends.map((b) => b.id),
      allowed_backends: allowedBackends,
    });
  }

  const capable = allowed.filter((b) => {
    const ok = !hasTools || b.supportsTools;
    if (!ok) decisions.push(`excluded ${b.id}: does not support tools`);
    return ok;
  });
  if (capable.length === 0) {
    throw new AppError("tools_unsupported", 422, "Tools were requested but no allowed backend supports tool calling", {
      allowed_backends: allowed.map((b) => b.id),
    });
  }

  return { candidates: [...capable].sort((a, b) => a.priority - b.priority), decisions };
}

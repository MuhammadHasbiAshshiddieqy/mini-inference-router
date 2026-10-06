import type { ThresholdsResult } from "../config/thresholds.ts";
import type { Queryable } from "../quota/quota.ts";

// Support assistant readiness (docs/05 §2.6): KB rows for the active embedding model, pg_trgm installed,
// calibrated thresholds present. Reported by /healthz with the command that fixes each problem.

export type AssistantReadiness = { ok: boolean; kb_rows: number | null; pg_trgm: boolean | null; problems: string[] };

export async function checkAssistantReadiness(
  db: Queryable,
  embeddingModel: string,
  thresholds: ThresholdsResult,
): Promise<AssistantReadiness> {
  const problems: string[] = [];
  if (!thresholds.ok) problems.push(`missing thresholds (${thresholds.missing.join(", ")}): run pnpm calibrate`);
  try {
    const [kb, ext] = await Promise.all([
      db.query<{ n: string }>("SELECT count(*) AS n FROM kb_entries WHERE embedding_model = $1", [embeddingModel]),
      db.query<{ n: string }>("SELECT count(*) AS n FROM pg_extension WHERE extname = 'pg_trgm'"),
    ]);
    const kbRows = Number(kb.rows[0]?.n ?? 0);
    const pgTrgm = Number(ext.rows[0]?.n ?? 0) > 0;
    if (kbRows === 0)
      problems.push(`no kb_entries for ${embeddingModel}: run pnpm kb:embed -- --provider <ollama|gemini>`);
    if (!pgTrgm) problems.push("pg_trgm is not installed: run pnpm db:migrate");
    return { ok: problems.length === 0, kb_rows: kbRows, pg_trgm: pgTrgm, problems };
  } catch (err) {
    problems.push(`database unreachable: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, kb_rows: null, pg_trgm: null, problems };
  }
}

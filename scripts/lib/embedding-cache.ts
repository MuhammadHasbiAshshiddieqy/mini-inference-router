import {
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// KB embedding cache (docs/02 §7): `<model>.f32` holds Float32 little-endian vectors in kb.jsonl row order,
// `<model>.meta.json` describes it. Committed to git so reviewers on CPU-only Docker skip re-embedding.
// While building, `complete` is false and `count` is the number of rows already written, which makes an
// interrupted run resumable.

export const CacheMetaSchema = z.object({
  model: z.string(),
  provider: z.enum(["gemini", "ollama"]),
  dims: z.number().int().positive(),
  count: z.number().int().nonnegative(),
  kb_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  complete: z.boolean(),
  updated_at: z.string(),
});
export type CacheMeta = z.infer<typeof CacheMetaSchema>;

export type CachePaths = { data: string; meta: string };

export function cachePaths(dir: string, model: string): CachePaths {
  const base = model.replace(/[^a-zA-Z0-9._-]/g, "_");
  return { data: join(dir, `${base}.f32`), meta: join(dir, `${base}.meta.json`) };
}

export function readMeta(paths: CachePaths): CacheMeta | undefined {
  if (!existsSync(paths.meta)) return undefined;
  return CacheMetaSchema.parse(JSON.parse(readFileSync(paths.meta, "utf-8")));
}

export function writeMeta(paths: CachePaths, meta: Omit<CacheMeta, "updated_at">): void {
  const full: CacheMeta = { ...meta, updated_at: new Date().toISOString() };
  writeFileSync(paths.meta, JSON.stringify(full, null, 2) + "\n");
}

export type CacheState =
  | { kind: "fresh"; meta: CacheMeta } // complete and matches the current kb.jsonl
  | { kind: "partial"; meta: CacheMeta } // same kb.jsonl and model, interrupted: resume at meta.count
  | { kind: "missing" }
  | { kind: "stale"; reason: string };

export function inspectCache(
  paths: CachePaths,
  expected: { model: string; dims: number; count: number; kbSha256: string },
): CacheState {
  const meta = readMeta(paths);
  if (!meta || !existsSync(paths.data)) return { kind: "missing" };
  if (meta.model !== expected.model) return { kind: "stale", reason: `cache is for ${meta.model}` };
  if (meta.dims !== expected.dims) return { kind: "stale", reason: `cache has ${meta.dims} dims` };
  if (meta.kb_sha256 !== expected.kbSha256)
    return { kind: "stale", reason: "kb.jsonl changed since the cache was built" };
  const bytes = statSync(paths.data).size;
  if (bytes < meta.count * meta.dims * 4) return { kind: "stale", reason: "data file is shorter than its meta says" };
  if (meta.complete) {
    return meta.count === expected.count && bytes === meta.count * meta.dims * 4
      ? { kind: "fresh", meta }
      : { kind: "stale", reason: "row count does not match kb.jsonl" };
  }
  return { kind: "partial", meta };
}

// Drops any bytes written after the last recorded batch (a crash between the data append and the meta write).
export function truncateToRows(paths: CachePaths, rows: number, dims: number): void {
  truncateSync(paths.data, rows * dims * 4);
}

export function startEmpty(paths: CachePaths): void {
  closeSync(openSync(paths.data, "w"));
}

export function appendVectors(paths: CachePaths, vectors: number[][], dims: number): void {
  const buf = Buffer.alloc(vectors.length * dims * 4);
  vectors.forEach((v, row) => {
    if (v.length !== dims) throw new Error(`vector ${row} has ${v.length} dims, expected ${dims}`);
    v.forEach((x, col) => buf.writeFloatLE(x, (row * dims + col) * 4));
  });
  appendFileSync(paths.data, buf);
}

export function readVectors(paths: CachePaths, rows: number, dims: number): number[][] {
  const buf = readFileSync(paths.data);
  if (buf.length < rows * dims * 4) throw new Error(`${paths.data}: expected ${rows} rows of ${dims} floats`);
  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: dims }, (_, col) => buf.readFloatLE((row * dims + col) * 4)),
  );
}

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendVectors,
  cachePaths,
  inspectCache,
  readVectors,
  startEmpty,
  truncateToRows,
  writeMeta,
  type CachePaths,
} from "./embedding-cache.ts";

const DIMS = 4;
const SHA = "a".repeat(64);
const expected = { model: "nomic-embed-text", dims: DIMS, count: 3, kbSha256: SHA };

let dir: string;
let paths: CachePaths;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "emb-cache-"));
  paths = cachePaths(dir, "nomic-embed-text");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function meta(count: number, complete: boolean, overrides: Partial<{ model: string; kb_sha256: string }> = {}) {
  writeMeta(paths, {
    model: "nomic-embed-text",
    provider: "ollama",
    dims: DIMS,
    count,
    kb_sha256: SHA,
    complete,
    ...overrides,
  });
}

describe("embedding cache", () => {
  it("sanitizes model names into file names", () => {
    expect(cachePaths("/c", "models/gemini-embedding-001").data).toBe("/c/models_gemini-embedding-001.f32");
  });

  it("round-trips float32 vectors in row order", () => {
    startEmpty(paths);
    appendVectors(paths, [[0.5, -0.25, 1, 0]], DIMS);
    appendVectors(
      paths,
      [
        [0.125, 0.75, -1, 2],
        [3, 4, 5, 6],
      ],
      DIMS,
    );
    expect(readVectors(paths, 3, DIMS)).toEqual([
      [0.5, -0.25, 1, 0],
      [0.125, 0.75, -1, 2],
      [3, 4, 5, 6],
    ]);
  });

  it("reports fresh, partial, missing and stale states", () => {
    expect(inspectCache(paths, expected).kind).toBe("missing");

    startEmpty(paths);
    appendVectors(paths, [[1, 1, 1, 1]], DIMS);
    meta(1, false);
    expect(inspectCache(paths, expected)).toMatchObject({ kind: "partial", meta: { count: 1 } });

    appendVectors(
      paths,
      [
        [1, 1, 1, 1],
        [1, 1, 1, 1],
      ],
      DIMS,
    );
    meta(3, true);
    expect(inspectCache(paths, expected).kind).toBe("fresh");

    meta(3, true, { kb_sha256: "b".repeat(64) });
    expect(inspectCache(paths, expected)).toMatchObject({ kind: "stale", reason: /kb.jsonl changed/ });

    meta(3, true, { model: "other-model" });
    expect(inspectCache(paths, expected).kind).toBe("stale");

    meta(3, true);
    expect(inspectCache(paths, { ...expected, count: 4 })).toMatchObject({ kind: "stale", reason: /row count/ });
  });

  it("drops a half-written batch when resuming", () => {
    startEmpty(paths);
    appendVectors(paths, [[1, 2, 3, 4]], DIMS);
    meta(1, false);
    appendFileSync(paths.data, Buffer.alloc(6)); // crash in the middle of the next append
    truncateToRows(paths, 1, DIMS);
    expect(readVectors(paths, 1, DIMS)).toEqual([[1, 2, 3, 4]]);
    expect(inspectCache(paths, expected).kind).toBe("partial");
  });
});

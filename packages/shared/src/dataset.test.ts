import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DATA_SPLITS, DatasetRowSchema, OOS_SPLITS, OosRowSchema } from "./dataset.ts";
import { INTENTS } from "./intents.ts";

// Guards the committed data/ files (produced by scripts/prepare_data.py) against drift from the TS enums.
const dataDir = new URL("../../../data/", import.meta.url);

function readJsonl(name: string): unknown[] {
  return readFileSync(new URL(`${name}.jsonl`, dataDir), "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

const EXPECTED_PER_INTENT = { kb: 50, dev: 10, eval: 1 } as const;

describe("committed dataset splits", () => {
  const manifest = JSON.parse(readFileSync(new URL("split_manifest.json", dataDir), "utf-8")) as {
    intents: string[];
  };

  it("manifest intents equal the shared INTENTS enum", () => {
    expect(manifest.intents).toEqual([...INTENTS].sort());
  });

  it.each(DATA_SPLITS)("%s.jsonl rows are valid and balanced per intent", (split) => {
    const rows = readJsonl(split).map((r) => DatasetRowSchema.parse(r));
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.intent, (counts.get(r.intent) ?? 0) + 1);
    expect(counts.size).toBe(INTENTS.length);
    for (const intent of INTENTS) expect(counts.get(intent)).toBe(EXPECTED_PER_INTENT[split]);
  });

  it("no row id appears in two splits", () => {
    const ids = DATA_SPLITS.flatMap((split) => readJsonl(split).map((r) => DatasetRowSchema.parse(r).id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("OOS files are valid, sized as specified, and never repeat an instruction", () => {
    const evalOos = readJsonl(OOS_SPLITS[0]).map((r) => OosRowSchema.parse(r));
    const devOos = readJsonl(OOS_SPLITS[1]).map((r) => OosRowSchema.parse(r));
    expect(evalOos).toHaveLength(5);
    expect(devOos).toHaveLength(15);
    const texts = [...evalOos, ...devOos].map((r) => r.instruction.toLowerCase());
    expect(new Set(texts).size).toBe(texts.length);
  });
});

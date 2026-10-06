import { z } from "zod";
import { IntentSchema } from "./intents.ts";

// Rows of the committed split files written by scripts/prepare_data.py (docs/02 §4–5).

// data/kb.jsonl, data/dev.jsonl, data/eval.jsonl
export const DatasetRowSchema = z.strictObject({
  id: z.string().regex(/^bitext-\d{5}$/),
  instruction: z.string().min(1),
  response: z.string().min(1),
  intent: IntentSchema,
  category: z.string().min(1),
  flags: z.string(),
});
export type DatasetRow = z.infer<typeof DatasetRowSchema>;

// data/eval_oos.jsonl, data/dev_oos.jsonl (handwritten)
export const OosRowSchema = z.strictObject({
  id: z.string().regex(/^oos-(eval|dev)-\d{2}$/),
  instruction: z.string().min(1),
  intent: z.literal("out_of_scope"),
});
export type OosRow = z.infer<typeof OosRowSchema>;

export const DATA_SPLITS = ["kb", "dev", "eval"] as const;
export const OOS_SPLITS = ["eval_oos", "dev_oos"] as const;

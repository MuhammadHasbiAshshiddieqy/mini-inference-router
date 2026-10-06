// Text normalization shared by the gateway (trigram matching on `kb_entries.instruction_norm` and on the query)
// and scripts/prepare_data.py (cross-split dedup). Both must produce identical output (docs/05 §2.2);
// normalize.fixtures.json is checked by both implementations.

const PLACEHOLDER = /\{\{.*?\}\}/g;
const NON_ALNUM = /[^\p{L}\p{N}\s]/gu; // same as Python `[^\w\s]|_` (underscore counts as punctuation)
const WHITESPACE = /\s+/g;

export function normalize(text: string): string {
  return text.toLowerCase().replace(PLACEHOLDER, " ").replace(NON_ALNUM, " ").replace(WHITESPACE, " ").trim();
}

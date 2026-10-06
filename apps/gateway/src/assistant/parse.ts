import { isSupportLabel, type SupportLabel } from "@mir/shared";

// Stream parser for the support answer (docs/05 §5), a small state machine: HEADER → SEPARATOR → BODY.
// Nothing is forwarded to the client until the header is valid, so a bad header can still be escalated or
// fall back. The output format is `INTENT: <label>` / `---` / answer.
//
// Tolerated: leading blank lines, markdown bold (`**INTENT:** x`, `**INTENT: x**`), surrounding whitespace,
// upper-case labels, and echoed `Line 1:` / `Line 2:` prefixes (Gemma 4 E2B copies the prompt's format lines).
// Invalid (→ escalate once, then refuse `unusable_model_output`):
//   - more than 200 chars before the header is complete, or before `---`;
//   - first non-empty line is not an INTENT header (e.g. "Sure! Here is…", JSON);
//   - label not in the 28-label enum;
//   - after the header, the next non-empty line is not `---`;
//   - stream ends before the header (or before `---` for an in-scope label);
//   - stream ends with an empty body for an in-scope label.
// For `out_of_scope` the header alone decides (refusal); anything after it is ignored.

export const MAX_HEADER_CHARS = 200;
const HEADER_RE = /^\**\s*(?:line\s*1\s*:\s*)?\**\s*INTENT\s*\**\s*:\s*\**\s*([A-Za-z_]+)\s*\**\s*$/i;
// "---", optionally bold, optionally with the echoed "Line 2:" prefix (seen from Gemma 4 E2B on 2026-10-06).
const SEPARATOR_RE = /^\**\s*(?:line\s*2\s*:\s*)?\**\s*-{3,}\s*\**$/i;

export class InvalidOutputError extends Error {
  override name = "InvalidOutputError";
}

export type ParseEvent = { type: "header"; label: SupportLabel } | { type: "body"; text: string };

export class SupportOutputParser {
  private state: "header" | "separator" | "body" = "header";
  private buffer = "";
  private consumed = 0; // chars of output seen before the body started
  label: SupportLabel | undefined;
  bodyChars = 0;

  // Feeds model text; returns the events it completes. Throws InvalidOutputError.
  push(text: string): ParseEvent[] {
    if (this.state === "body") return this.body(text);
    this.buffer += text;
    this.consumed += text.length;
    const events: ParseEvent[] = [];

    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line === "") continue;

      if (this.state === "header") {
        const match = HEADER_RE.exec(line);
        if (!match?.[1]) throw new InvalidOutputError(`first line is not an INTENT header: "${line.slice(0, 80)}"`);
        const label = match[1].toLowerCase();
        if (!isSupportLabel(label)) throw new InvalidOutputError(`unknown intent label "${label}"`);
        this.label = label;
        events.push({ type: "header", label });
        if (label === "out_of_scope") {
          this.state = "body"; // decided by the header; the rest is ignored
          this.buffer = "";
          return events;
        }
        this.state = "separator";
        continue;
      }

      // separator
      if (!SEPARATOR_RE.test(line))
        throw new InvalidOutputError(`expected "---" after the header, got "${line.slice(0, 80)}"`);
      this.state = "body";
      const rest = this.buffer.replace(/^\s+/, "");
      this.buffer = "";
      return [...events, ...this.body(rest)];
    }

    if (this.consumed > MAX_HEADER_CHARS) {
      throw new InvalidOutputError(`no complete INTENT header and "---" within ${MAX_HEADER_CHARS} chars`);
    }
    return events;
  }

  // Call when the stream ends normally. Returns a late header event (output that is just
  // "INTENT: out_of_scope" with no newline). Throws InvalidOutputError if the output is unusable.
  finish(): ParseEvent[] {
    if (this.state === "header") {
      const line = this.buffer.trim();
      const label = (line ? HEADER_RE.exec(line)?.[1] : undefined)?.toLowerCase();
      if (label === "out_of_scope") {
        this.label = "out_of_scope";
        this.state = "body";
        return [{ type: "header", label }];
      }
      throw new InvalidOutputError(line ? "stream ended inside the INTENT header" : "empty output");
    }
    if (this.label === "out_of_scope") return [];
    if (this.state === "separator") {
      const rest = this.buffer.trim();
      if (rest === "") throw new InvalidOutputError('stream ended before "---"');
      if (SEPARATOR_RE.test(rest)) throw new InvalidOutputError("empty answer after the header");
      throw new InvalidOutputError(`expected "---" after the header, got "${rest.slice(0, 80)}"`);
    }
    if (this.bodyChars === 0) throw new InvalidOutputError("empty answer after the header");
    return [];
  }

  private body(text: string): ParseEvent[] {
    if (this.label === "out_of_scope" || text === "") return [];
    // Leading whitespace right after the separator is dropped.
    const out = this.bodyChars === 0 ? text.replace(/^\s+/, "") : text;
    if (out === "") return [];
    this.bodyChars += out.trim().length;
    return [{ type: "body", text: out }];
  }
}

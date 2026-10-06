import { describe, expect, it } from "vitest";
import { INTENTS, SUPPORT_LABELS, isSupportLabel } from "./intents.ts";

describe("intents", () => {
  it("has the 27 Bitext intents, unique", () => {
    expect(INTENTS).toHaveLength(27);
    expect(new Set(INTENTS).size).toBe(27);
  });

  it("support labels add out_of_scope as the 28th label", () => {
    expect(SUPPORT_LABELS).toHaveLength(28);
    expect(SUPPORT_LABELS.at(-1)).toBe("out_of_scope");
  });

  it("recognises labels exactly (case-sensitive, no extras)", () => {
    expect(isSupportLabel("track_refund")).toBe(true);
    expect(isSupportLabel("out_of_scope")).toBe(true);
    expect(isSupportLabel("Track_Refund")).toBe(false);
    expect(isSupportLabel("refund")).toBe(false);
  });
});

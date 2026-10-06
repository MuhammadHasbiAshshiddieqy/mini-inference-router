import { describe, expect, it } from "vitest";
import fixtures from "./normalize.fixtures.json" with { type: "json" };
import { normalize } from "./normalize.ts";

describe("normalize", () => {
  // The same fixtures are asserted by scripts/prepare_data.py at start-up, so Python and TS cannot drift.
  it.each(fixtures)("$input → $expected", ({ input, expected }) => {
    expect(normalize(input)).toBe(expected);
  });

  it("is idempotent", () => {
    for (const { input } of fixtures) expect(normalize(normalize(input))).toBe(normalize(input));
  });
});

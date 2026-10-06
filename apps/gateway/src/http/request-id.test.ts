import { describe, expect, it } from "vitest";
import { uuidv7 } from "./request-id.ts";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidv7", () => {
  it("has the v7 version and RFC 9562 variant bits", () => {
    for (let i = 0; i < 100; i++) expect(uuidv7()).toMatch(UUID_V7);
  });

  it("encodes the timestamp in the first 48 bits", () => {
    const ts = Date.UTC(2026, 9, 6, 6, 0, 0);
    const id = uuidv7(ts);
    expect(parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(ts);
  });

  it("sorts by creation time", () => {
    const ids = [uuidv7(1_000), uuidv7(2_000), uuidv7(3_000)];
    expect([...ids].sort()).toEqual(ids);
  });
});

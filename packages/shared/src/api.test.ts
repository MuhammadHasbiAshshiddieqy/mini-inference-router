import { describe, expect, it } from "vitest";
import { CHAT_MAX_TOTAL_CHARS, ChatRequestSchema, SupportRequestSchema } from "./api.ts";

describe("ChatRequestSchema", () => {
  const user = (content: string) => ({ role: "user" as const, content });

  it("accepts a minimal request", () => {
    expect(ChatRequestSchema.safeParse({ messages: [user("hi")] }).success).toBe(true);
  });

  it("rejects empty messages, more than 20 messages, and unknown roles", () => {
    expect(ChatRequestSchema.safeParse({ messages: [] }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ messages: Array.from({ length: 21 }, () => user("x")) }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ messages: [{ role: "tool", content: "x" }] }).success).toBe(false);
  });

  it("enforces the total character budget across messages", () => {
    const half = "a".repeat(CHAT_MAX_TOTAL_CHARS / 2);
    expect(ChatRequestSchema.safeParse({ messages: [user(half), user(half)] }).success).toBe(true);
    expect(ChatRequestSchema.safeParse({ messages: [user(half), user(half + "a")] }).success).toBe(false);
  });

  it("rejects unknown fields so client typos surface as 400", () => {
    expect(ChatRequestSchema.safeParse({ messages: [user("hi")], max_tokens: 100 }).success).toBe(false);
  });

  it("validates debug options", () => {
    const base = { messages: [user("hi")] };
    expect(
      ChatRequestSchema.safeParse({ ...base, debug: { force_fail: ["mock"], mock_latency_ms: 500 } }).success,
    ).toBe(true);
    expect(ChatRequestSchema.safeParse({ ...base, debug: { mock_latency_ms: 20_001 } }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ ...base, debug: { unknown: true } }).success).toBe(false);
  });
});

describe("SupportRequestSchema", () => {
  it("trims the message and enforces 1..2000 chars after trim", () => {
    const ok = SupportRequestSchema.safeParse({ message: "  cancel my order  " });
    expect(ok.success && ok.data.message).toBe("cancel my order");
    expect(SupportRequestSchema.safeParse({ message: "   " }).success).toBe(false);
    expect(SupportRequestSchema.safeParse({ message: "a".repeat(2001) }).success).toBe(false);
  });

  it("rejects non-integer or out-of-range max_output_tokens", () => {
    expect(SupportRequestSchema.safeParse({ message: "hi", max_output_tokens: 0 }).success).toBe(false);
    expect(SupportRequestSchema.safeParse({ message: "hi", max_output_tokens: 1.5 }).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { createSseParser, parseSseText } from "./sse-parser.ts";

describe("SSE parser", () => {
  it("parses named events and ignores heartbeat comments", () => {
    expect(parseSseText(': ping\n\nevent: token\ndata: {"text":"Hi"}\n\n: ping\n\nevent: done\ndata: {}\n\n')).toEqual([
      { event: "token", data: '{"text":"Hi"}' },
      { event: "done", data: "{}" },
    ]);
  });

  it("handles events split across arbitrary chunks and CRLF line endings", () => {
    const events: string[] = [];
    const parser = createSseParser((e) => events.push(`${e.event}=${e.data}`));
    for (const chunk of [
      "eve",
      "nt: tok",
      "en\r\nda",
      'ta: {"text":"a"}\r',
      "\n\r\n",
      "event: done\ndata: 1\n",
      "\n",
    ]) {
      parser.push(chunk);
    }
    expect(events).toEqual(['token={"text":"a"}', "done=1"]);
  });

  it("does not end an event early when a CRLF is split across chunks", () => {
    const events: string[] = [];
    const parser = createSseParser((e) => events.push(e.data));
    for (const chunk of ["data: a\r", "\ndata: b\r", "\n\r", "\n"]) parser.push(chunk);
    expect(events).toEqual(["a\nb"]);
  });

  it("joins multi-line data and defaults the event name to message", () => {
    expect(parseSseText("data: line 1\ndata: line 2\n\n")).toEqual([{ event: "message", data: "line 1\nline 2" }]);
  });

  it("drops an unterminated final event", () => {
    expect(parseSseText("event: token\ndata: partial")).toEqual([]);
  });
});

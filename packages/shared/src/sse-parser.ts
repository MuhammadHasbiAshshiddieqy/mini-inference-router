// Incremental parser for `text/event-stream` (WHATWG SSE format), shared by the console, the eval runner
// and tests. EventSource cannot send an Authorization header, so clients read the stream with fetch() and
// feed decoded text here. Comment lines (`: ping` heartbeats) are ignored. Validate payloads with parseSseEvent().

export type RawSseEvent = { event: string; data: string };

export function createSseParser(onEvent: (event: RawSseEvent) => void) {
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length > 0) onEvent({ event: eventName || "message", data: dataLines.join("\n") });
    eventName = "";
    dataLines = [];
  };

  const line = (raw: string) => {
    if (raw === "") return dispatch();
    if (raw.startsWith(":")) return; // comment / heartbeat
    const colon = raw.indexOf(":");
    const field = colon === -1 ? raw : raw.slice(0, colon);
    let value = colon === -1 ? "" : raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    // `id` and `retry` are not used by this API.
  };

  return {
    push(text: string) {
      buffer += text;
      let newline: number;
      while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
        // A trailing "\r" may be the first half of a "\r\n" split across chunks: wait for the next chunk.
        if (buffer[newline] === "\r" && newline === buffer.length - 1) break;
        const isCrlf = buffer[newline] === "\r" && buffer[newline + 1] === "\n";
        line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + (isCrlf ? 2 : 1));
      }
    },
    // End of stream: a final event without a trailing blank line is dropped, as the SSE spec requires.
    end() {
      buffer = "";
      eventName = "";
      dataLines = [];
    },
  };
}

// Convenience for tests and the eval runner: parse a complete stream body.
export function parseSseText(text: string): RawSseEvent[] {
  const events: RawSseEvent[] = [];
  const parser = createSseParser((e) => events.push(e));
  parser.push(text);
  parser.end();
  return events;
}

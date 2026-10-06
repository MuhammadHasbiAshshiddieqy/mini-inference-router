import type { AttemptStatus, SseEvent, SseEventData } from "@mir/shared";

// State of one playground run, built only from the SSE events (so the inspector shows exactly what the
// gateway reported). A pure reducer: easy to reason about, no hidden state.

export type AttemptRow = {
  attempt: number;
  backend_id: string;
  model: string;
  reason: string;
  status: AttemptStatus | "running";
  error: string | null;
  latency_ms: number | null;
};

export type RunState = {
  status: "idle" | "streaming" | "done" | "error" | "stopped";
  requestId: string | null;
  answer: string;
  toolCalls: SseEventData<"tool_call">[];
  meta: SseEventData<"meta"> | null;
  retrieval: SseEventData<"retrieval"> | null;
  intent: SseEventData<"intent"> | null;
  refusal: SseEventData<"refusal"> | null;
  streamError: SseEventData<"error"> | null; // mid-stream error event
  httpError: { status: number; code: string; message: string } | null; // non-2xx before the stream opened
  done: SseEventData<"done"> | null;
  attempts: AttemptRow[];
  raw: { at: number; event: string; data: unknown }[];
  startedAt: number;
  firstTokenAt: number | null;
};

export function emptyRun(): RunState {
  return {
    status: "idle",
    requestId: null,
    answer: "",
    toolCalls: [],
    meta: null,
    retrieval: null,
    intent: null,
    refusal: null,
    streamError: null,
    httpError: null,
    done: null,
    attempts: [],
    raw: [],
    startedAt: 0,
    firstTokenAt: null,
  };
}

export function applyEvent(s: RunState, e: SseEvent, now: number): void {
  s.raw.push({ at: Math.round(now - s.startedAt), event: e.event, data: e.data });
  switch (e.event) {
    case "meta":
      s.meta = e.data;
      s.requestId = e.data.request_id;
      break;
    case "retrieval":
      s.retrieval = e.data;
      break;
    case "route":
      s.attempts.push({ ...e.data, status: "running", error: null, latency_ms: null });
      break;
    case "attempt_failed": {
      const row = s.attempts.find((a) => a.attempt === e.data.attempt);
      if (row) Object.assign(row, { status: e.data.status, error: e.data.error, latency_ms: e.data.latency_ms });
      break;
    }
    case "intent":
      s.intent = e.data;
      break;
    case "token":
      s.firstTokenAt ??= now;
      s.answer += e.data.text;
      break;
    case "tool_call":
      s.toolCalls.push(e.data);
      break;
    case "refusal":
      s.refusal = e.data;
      break;
    case "error":
      s.streamError = e.data;
      break;
    case "done": {
      s.done = e.data;
      const served = e.data.served_by;
      for (const a of s.attempts) {
        if (a.status === "running") a.status = served && a.backend_id === served.backend_id ? "ok" : "aborted";
      }
      s.status = "done";
      break;
    }
  }
}

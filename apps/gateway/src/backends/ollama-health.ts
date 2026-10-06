import type { Logger } from "pino";
import type { Backend } from "./types.ts";

// Cheap Ollama checks (docs/04 §2): `GET /api/tags` only, never a generation, so /healthz costs nothing.
// A missing model is logged with the fix; the gateway keeps running and the router falls back to mock.

export type OllamaStatus = {
  reachable: boolean;
  models_present: Record<string, boolean>;
  error?: string;
};

export async function probeOllama(host: string, models: string[], timeoutMs = 1500): Promise<OllamaStatus> {
  try {
    const res = await fetch(new URL("/api/tags", host), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { reachable: false, models_present: {}, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { models?: { name?: string }[] };
    const names = new Set((body.models ?? []).flatMap((m) => (m.name ? [m.name, m.name.replace(/:latest$/, "")] : [])));
    return { reachable: true, models_present: Object.fromEntries(models.map((m) => [m, names.has(m)])) };
  } catch (err) {
    return { reachable: false, models_present: {}, error: err instanceof Error ? err.message : String(err) };
  }
}

// Boot check + warm-up for the local runner: log what is missing, then load the chat model in the background
// with a 1-token generation so the first user request does not pay the model load time.
export async function checkAndWarmUpOllama(
  backend: Backend,
  host: string,
  embedModel: string,
  logger: Logger,
): Promise<void> {
  const status = await probeOllama(host, [backend.spec.model, embedModel], 3000);
  if (!status.reachable) {
    logger.warn(
      { ollama_url: host, error: status.error },
      "Ollama is not reachable; requests will fall back to mock until it is (start `ollama serve` or the ollama compose profile)",
    );
    return;
  }
  const missing = Object.entries(status.models_present)
    .filter(([, present]) => !present)
    .map(([m]) => m);
  if (missing.length > 0) {
    logger.warn(
      { missing },
      `Ollama models missing: run ${missing.map((m) => `\`ollama pull ${m}\``).join(" and ")} (or \`docker compose --profile ollama up ollama-pull\`)`,
    );
    if (missing.includes(backend.spec.model)) return;
  }
  const started = performance.now();
  try {
    for await (const chunk of backend.stream({
      messages: [{ role: "user", content: "ok" }],
      maxOutputTokens: 1,
      signal: AbortSignal.timeout(backend.spec.totalTimeoutMs),
    })) {
      void chunk; // drain
    }
    logger.info({ model: backend.spec.model, ms: Math.round(performance.now() - started) }, "Ollama warm-up done");
  } catch (err) {
    logger.warn({ err, model: backend.spec.model }, "Ollama warm-up failed (requests will still try it)");
  }
}

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.ts";
import { createLogger } from "../logger.ts";
import { execute, totals } from "../router/execute.ts";
import { createBackendRegistry } from "./registry.ts";

// Opt-in live smoke tests (docs/04 §8): one tiny real generation per backend through the real router.
//   LIVE=gemini   → gemini-3.5-flash and gemini-3-flash (2 requests, needs GEMINI_API_KEY)
//   LIVE=ollama   → the Ollama chat model (needs `ollama serve`)
//   LIVE=1        → both
// Never run in the default test suite: they cost quota and need network.

const live = process.env["LIVE"] ?? "";
const rootEnv = new URL("../../../../.env", import.meta.url);
if (live && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const runGemini = live === "1" || live === "gemini";
const runOllama = live === "1" || live === "ollama";
const logger = createLogger("silent");

async function smoke(profile: "cloud" | "local", backendId: string) {
  const env = loadEnv({ ...process.env, PROFILE: profile });
  const registry = createBackendRegistry(env);
  const backend = registry.backends.find((b) => b.spec.id === backendId);
  if (!backend) throw new Error(`${backendId} is not in the ${profile} profile`);
  let text = "";
  const result = await execute({
    candidates: [backend.spec],
    backendFor: () => backend,
    request: {
      system: "You are a concise support assistant.",
      messages: [{ role: "user", content: "Reply with one short sentence: how do I track a refund?" }],
      maxOutputTokens: 64,
    },
    hooks: {
      onChunk: (chunk, ctx) => {
        if (chunk.type === "text") text += chunk.text;
        ctx.commit();
      },
    },
    logger,
  });
  return { result, text, sum: totals(result.attempts) };
}

describe.skipIf(!runGemini)("LIVE gemini", () => {
  it.each(["gemini-3.5-flash", "gemini-3-flash"])(
    "%s streams text with provider-reported usage",
    async (id) => {
      const { result, text, sum } = await smoke("cloud", id);
      expect(result.outcome, JSON.stringify(result.error)).toBe("ok");
      expect(text.trim().length).toBeGreaterThan(5);
      expect(sum.promptTokens).toBeGreaterThan(0);
      expect(sum.completionTokens).toBeGreaterThan(0);
      expect(sum.estimated).toBe(false);
      expect(Number(sum.costUsd)).toBeGreaterThan(0);
      console.log(
        `${id}: ttft=${result.ttftMs}ms tokens=${sum.totalTokens} (thinking ${sum.thinkingTokens}) cost=$${sum.costUsd} :: ${text.trim()}`,
      );
    },
    60_000,
  );
});

describe.skipIf(!runOllama)("LIVE ollama", () => {
  it("streams text with provider-reported usage", async () => {
    const { result, text, sum } = await smoke("local", "ollama");
    expect(result.outcome, JSON.stringify(result.error)).toBe("ok");
    expect(text.trim().length).toBeGreaterThan(5);
    expect(sum.promptTokens).toBeGreaterThan(0);
    expect(sum.estimated).toBe(false);
    console.log(`ollama: ttft=${result.ttftMs}ms tokens=${sum.totalTokens} :: ${text.trim()}`);
  }, 120_000);
});

import { ProfileSchema } from "@mir/shared";
import { z } from "zod";

// All environment variables, parsed once at startup (docs/03 §8). Startup fails fast with a readable message.

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const positiveInt = z.coerce.number().int().positive();
const unitInterval = z.coerce.number().min(0).max(1);

const EnvSchema = z.object({
  PROFILE: ProfileSchema.default("local"),
  PORT: positiveInt.default(8787),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  ADMIN_API_KEY: z.string().min(8, "must be at least 8 characters"),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  GEMINI_API_KEY: z.string().optional(),
  // source: https://ai.google.dev/gemini-api/docs/models, checked 2026-10-06 (gemini-3.5-flash stable, gemini-3-flash-preview preview)
  GEMINI_PRIMARY_MODEL: z.string().default("gemini-3.5-flash"),
  GEMINI_FALLBACK_MODEL: z.string().default("gemini-3-flash-preview"),
  GEMINI_THINKING_LEVEL: z.enum(["minimal", "low", "medium", "high"]).default("minimal"),
  // source: https://ai.google.dev/gemini-api/docs/models, checked 2026-10-06. The embeddings page now names
  // gemini-embedding-2; the final embedding model is decided in Phase 2.
  GEMINI_EMBED_MODEL: z.string().default("gemini-embedding-001"),
  GEMINI_TTFT_TIMEOUT_MS: positiveInt.default(8000),
  GEMINI_TOTAL_TIMEOUT_MS: positiveInt.default(30_000),

  OLLAMA_URL: z.url().default("http://localhost:11434"),
  OLLAMA_CHAT_MODEL: z.string().default("gemma4:e2b-mlx"),
  OLLAMA_THINK: bool.default(false),
  OLLAMA_EMBED_MODEL: z.string().default("nomic-embed-text"),
  OLLAMA_SUPPORTS_TOOLS: bool.default(true),
  OLLAMA_TTFT_TIMEOUT_MS: positiveInt.default(20_000),
  OLLAMA_TOTAL_TIMEOUT_MS: positiveInt.default(60_000),

  MOCK_LATENCY_MS: z.coerce.number().int().min(0).max(20_000).default(300),
  MOCK_FAIL_RATE: unitInterval.default(0),

  LOCAL_COST_PER_1M: z.coerce.number().min(0).default(0),

  RETRIEVAL_TOP_K: positiveInt.max(20).default(5),
  RETRIEVAL_MODE: z.enum(["dense", "hybrid"]).default("dense"),
  RETRIEVAL_CANDIDATES: positiveInt.max(200).default(20),
  RRF_K: positiveInt.default(60),
  RETRIEVAL_LEXICAL_FALLBACK: bool.default(true),
  // Optional overrides; normally loaded from data/thresholds.json (docs/05 §7).
  CONFIDENCE_T_OOS: unitInterval.optional(),
  CONFIDENCE_T_HIGH: unitInterval.optional(),
  CONFIDENCE_T_TRGM_OOS: unitInterval.optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export class EnvError extends Error {
  override name = "EnvError";
}

export function loadEnv(source: Record<string, string | undefined>): Env {
  // Treat empty values (`GEMINI_API_KEY=`) as unset, so defaults and "required" checks apply.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const result = EnvSchema.safeParse(cleaned);
  const lines = result.success
    ? []
    : result.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);

  // GEMINI_* is required only when the active profile uses Gemini (docs/03 §8). Checked here rather than
  // in a Zod refinement so it is reported together with any other invalid variable.
  const profile = cleaned["PROFILE"] ?? "local";
  if (profile !== "local" && !cleaned["GEMINI_API_KEY"]) {
    lines.push(`  - GEMINI_API_KEY: required when PROFILE=${profile}`);
  }

  if (!result.success || lines.length > 0) {
    throw new EnvError(`Invalid environment configuration:\n${lines.join("\n")}\nSee .env.example.`);
  }
  return result.data;
}

export function embeddingModelFor(env: Env): string {
  return env.PROFILE === "local" ? env.OLLAMA_EMBED_MODEL : env.GEMINI_EMBED_MODEL;
}

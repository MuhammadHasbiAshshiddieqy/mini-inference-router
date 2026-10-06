import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { EMBEDDING_DIMS } from "../embeddings/types.ts";

// docs/03 §6. Extensions `vector` and `pg_trgm` are created by the first (hand-written) migration.

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  apiKeyHash: text("api_key_hash").notNull().unique(), // sha256 hex of the key; the key itself is never stored
  apiKeyPrefix: text("api_key_prefix").notNull(), // first 8 chars, for logs and UI
  quotaTokens: bigint("quota_tokens", { mode: "number" }).notNull(),
  usedTokens: bigint("used_tokens", { mode: "number" }).notNull().default(0), // consumed + currently reserved
  allowedBackends: text("allowed_backends").array().notNull(),
  maxOutputTokens: integer("max_output_tokens").notNull().default(1024),
  allowDebug: boolean("allow_debug").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const requests = pgTable(
  "requests",
  {
    id: uuid("id").primaryKey(), // = request_id (UUIDv7)
    tenantId: text("tenant_id").references(() => tenants.id),
    endpoint: text("endpoint").notNull(), // 'chat' | 'support'
    profile: text("profile").notNull(), // 'cloud' | 'local' | 'hybrid'
    outcome: text("outcome").notNull(), // docs/03 §7
    servedBackendId: text("served_backend_id"),
    servedModel: text("served_model"),
    fallbackFired: boolean("fallback_fired").notNull().default(false),
    escalated: boolean("escalated").notNull().default(false),
    attemptsCount: integer("attempts_count").notNull().default(0),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    thinkingTokens: integer("thinking_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0), // across all attempts
    tokensEstimated: boolean("tokens_estimated").notNull().default(false),
    costUsd: numeric("cost_usd", { precision: 12, scale: 8 }).notNull().default("0"), // string in TS: never a float
    latencyMs: integer("latency_ms"),
    ttftMs: integer("ttft_ms"),
    intent: text("intent"),
    confidenceLevel: text("confidence_level"),
    confidenceScore: real("confidence_score"),
    retrievedIds: text("retrieved_ids").array(),
    retrievalMode: text("retrieval_mode"), // 'dense' | 'hybrid' | 'lexical_fallback' (support only)
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("requests_tenant_created_idx").on(t.tenantId, t.createdAt.desc())],
);

export const routeAttempts = pgTable("route_attempts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  requestId: uuid("request_id")
    .notNull()
    .references(() => requests.id, { onDelete: "cascade" }),
  attemptNo: integer("attempt_no").notNull(),
  backendId: text("backend_id").notNull(),
  model: text("model").notNull(),
  reason: text("reason").notNull(), // 'primary' | 'fallback:<prev_status>' | 'escalation:<why>'
  status: text("status").notNull(), // docs/03 §6 attempt statuses
  errorDetail: text("error_detail"),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  thinkingTokens: integer("thinking_tokens"),
  costUsd: numeric("cost_usd", { precision: 12, scale: 8 }).notNull().default("0"),
  latencyMs: integer("latency_ms"),
  ttftMs: integer("ttft_ms"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
});

export const kbEntries = pgTable(
  "kb_entries",
  {
    id: text("id").notNull(), // 'bitext-01234'
    embeddingModel: text("embedding_model").notNull(), // vector spaces are never mixed
    intent: text("intent").notNull(),
    category: text("category").notNull(),
    flags: text("flags"),
    instruction: text("instruction").notNull(),
    response: text("response").notNull(),
    instructionNorm: text("instruction_norm").notNull(), // normalize(instruction), for pg_trgm (docs/05 §2.2)
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMS }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.embeddingModel] }),
    index("kb_entries_embedding_model_idx").on(t.embeddingModel),
    // 1,350 rows per model: an exact scan is fast enough, so no ANN index (docs/03 §6).
  ],
);

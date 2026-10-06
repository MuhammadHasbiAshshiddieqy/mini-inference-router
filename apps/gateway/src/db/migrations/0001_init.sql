CREATE TABLE "kb_entries" (
	"id" text NOT NULL,
	"embedding_model" text NOT NULL,
	"intent" text NOT NULL,
	"category" text NOT NULL,
	"flags" text,
	"instruction" text NOT NULL,
	"response" text NOT NULL,
	"instruction_norm" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	CONSTRAINT "kb_entries_id_embedding_model_pk" PRIMARY KEY("id","embedding_model")
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"endpoint" text NOT NULL,
	"profile" text NOT NULL,
	"outcome" text NOT NULL,
	"served_backend_id" text,
	"served_model" text,
	"fallback_fired" boolean DEFAULT false NOT NULL,
	"escalated" boolean DEFAULT false NOT NULL,
	"attempts_count" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"thinking_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"tokens_estimated" boolean DEFAULT false NOT NULL,
	"cost_usd" numeric(12, 8) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"ttft_ms" integer,
	"intent" text,
	"confidence_level" text,
	"confidence_score" real,
	"retrieved_ids" text[],
	"retrieval_mode" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "route_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"backend_id" text NOT NULL,
	"model" text NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"error_detail" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"thinking_tokens" integer,
	"cost_usd" numeric(12, 8) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"ttft_ms" integer,
	"started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"api_key_prefix" text NOT NULL,
	"quota_tokens" bigint NOT NULL,
	"used_tokens" bigint DEFAULT 0 NOT NULL,
	"allowed_backends" text[] NOT NULL,
	"max_output_tokens" integer DEFAULT 1024 NOT NULL,
	"allow_debug" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_api_key_hash_unique" UNIQUE("api_key_hash")
);
--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_attempts" ADD CONSTRAINT "route_attempts_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_entries_embedding_model_idx" ON "kb_entries" USING btree ("embedding_model");--> statement-breakpoint
CREATE INDEX "requests_tenant_created_idx" ON "requests" USING btree ("tenant_id","created_at" DESC NULLS LAST);
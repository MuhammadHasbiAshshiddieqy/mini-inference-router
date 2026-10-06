-- Hand-written: drizzle-kit does not manage extensions. Must run before the tables that use them.
-- Neon: vector 0.8.x and pg_trgm 1.6 on PG14–18 (https://neon.com/docs/extensions/pg-extensions, checked 2026-10-06).
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;

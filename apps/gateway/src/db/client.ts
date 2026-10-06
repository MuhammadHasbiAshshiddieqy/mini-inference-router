import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.ts";

export type Db = NodePgDatabase<typeof schema>;
export type DbHandle = { db: Db; pool: pg.Pool };

export type DbOptions = {
  databaseUrl: string;
  timeoutMs: number;
  onIdleError?: (err: Error) => void;
};

// One small pool per process (docs/08 §2): Neon's pooled endpoint does the real pooling, and serverless
// instances must not hold many idle connections. TLS follows the URL (`sslmode=require` on Neon).
export function createDb({ databaseUrl, timeoutMs, onIdleError }: DbOptions): DbHandle {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 3,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
  });
  // An idle client can error (e.g. the server closed it). Without a listener this would crash the process.
  pool.on("error", (err) => onIdleError?.(err));
  return { db: drizzle(pool, { schema }), pool };
}

// Lazily creates the pool on first use and reuses it across requests (and warm serverless invocations).
export function lazyDb(options: DbOptions): () => DbHandle {
  let handle: DbHandle | undefined;
  return () => (handle ??= createDb(options));
}

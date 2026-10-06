import { parseArgs, type ParseArgsConfig } from "node:util";
import { z } from "zod";

// Shared helpers for the TS scripts. Each script parses only the env vars it needs, so it can run in the
// Docker `migrate` service without the gateway's full configuration.

export function parseCliArgs<T extends NonNullable<ParseArgsConfig["options"]>>(options: T) {
  // `pnpm kb:embed -- --provider x` forwards a literal "--"; drop it.
  const args = process.argv.slice(2).filter((a, i) => !(i === 0 && a === "--"));
  return parseArgs({ args, options, strict: true, allowPositionals: false }).values;
}

export function parseScriptEnv<S extends z.ZodRawShape>(shape: S): z.infer<z.ZodObject<S>> {
  const cleaned = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const result = z.object(shape).safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    fail(`Invalid environment configuration:\n${lines.join("\n")}\nSee .env.example.`);
  }
  return result.data;
}

export const databaseEnv = {
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DB_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
};

export function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

// Prints the host/db of a connection string without credentials.
export function describeDatabase(url: string): string {
  const u = new URL(url);
  return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
}

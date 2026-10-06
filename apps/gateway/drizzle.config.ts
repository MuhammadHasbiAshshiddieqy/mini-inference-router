import { defineConfig } from "drizzle-kit";

// Used only to generate SQL migrations from src/db/schema.ts (`pnpm --filter gateway db:generate`).
// Migrations are applied by scripts/migrate.ts (`pnpm db:migrate`), which needs no drizzle-kit at runtime.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
});

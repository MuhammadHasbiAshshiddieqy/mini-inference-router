import { defineConfig } from "vitest/config";

// Root config: `pnpm exec vitest` from the root runs every project at once.
// `pnpm -r test` runs each package's own `vitest run` instead.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/gateway"],
  },
});

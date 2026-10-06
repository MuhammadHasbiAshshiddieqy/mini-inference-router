import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share one test database and truncate it between tests, so files run one at a time.
    fileParallelism: false,
  },
});

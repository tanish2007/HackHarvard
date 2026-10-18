/**
 * Root vitest config. Runs only the lanes that use vitest.
 *
 * Text uses node:test (`npm test` inside text/) and Data uses pytest, so
 * their test files are left to their own runners.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["core/test/**/*.test.ts", "voice/test/**/*.test.ts"],
  },
});

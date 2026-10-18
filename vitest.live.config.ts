/**
 * Vitest config for the live checks that call real Gemini.
 *
 * Run with `npm run test:live`. Kept apart from vitest.config.ts so
 * `npm test` never needs an API key or uses quota. Cases run one at a time
 * to stay under the free tier's per-minute limit.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["core/test/live/**/*.eval.ts"],
    fileParallelism: false,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    include: ["tests/**/*.test.ts"],
    exclude: ["references/**", "node_modules/**"],
    testTimeout: 30000, // Integration tests may need more time
  },
});

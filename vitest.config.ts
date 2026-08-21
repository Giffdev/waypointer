import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    exclude: [
      ...configDefaults.exclude,
      "e2e/**",
      ".vercel/**",
      ".airport-alias-*-worktree/**",
    ],
    setupFiles: ["./vitest.setup.ts"],
  },
});

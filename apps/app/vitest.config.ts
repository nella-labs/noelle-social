import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // Match Next's automatic JSX runtime so component (.tsx) imports render in
  // tests without an explicit `import React`.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    // Keep DOM suites responsive alongside other workspace checks.
    maxWorkers: 2,
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // `server-only` is a Next.js build-time guard with no Node entry point;
      // stub it so server-only modules (e.g. lib/vault-fs.ts) import under vitest.
      "server-only": path.resolve(__dirname, "./src/test/server-only-stub.ts"),
    },
  },
});

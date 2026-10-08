import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Native fixtures share cluster-level grants even with separate databases.
    fileParallelism: !Object.entries(process.env).some(([key, value]) =>
      key.startsWith("NOELLE_") && key.endsWith("_TEST_DATABASE_URL") && !!value),
    // The first test in the send suite pays the cold-start cost of loading the
    // full route module graph (@noelle/x-client + @noelle/secrets + GCP libs) on
    // top of running the heaviest stubbed flow. On a slow CI runner that can
    // exceed vitest's 5s default and flake — the suite itself runs in <1s warm.
    // 20s leaves ample headroom for cold-start while still catching real hangs.
    testTimeout: 20_000,
  },
});

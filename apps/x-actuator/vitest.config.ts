import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Bound DOM and module-isolation workers when the full monorepo gate runs.
    maxWorkers: 2,
    // Per-glob environment overrides (tests/dom/** → jsdom) are configured
    // via vitest workspace projects when actual DOM tests are added.
  },
});

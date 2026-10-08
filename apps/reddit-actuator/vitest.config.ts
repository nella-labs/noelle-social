import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Per-glob environment overrides (tests/dom/** → jsdom) are configured
    // via vitest workspace projects when actual DOM tests are added.
  },
});

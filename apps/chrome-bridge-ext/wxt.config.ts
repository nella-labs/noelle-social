import { defineConfig } from "wxt";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Build stamp minted once per build. Embedded via vite define (__BUILD_STAMP__)
// and written to .output/chrome-mv3/build-stamp.json so api-vm can serve it and
// the extension can self-reload when a newer build lands (LinkedIn actuator
// pattern, PR #447/#448/#450).
const BUILD_STAMP = new Date().toISOString();

export default defineConfig({
  vite: () => ({
    define: { __BUILD_STAMP__: JSON.stringify(BUILD_STAMP) },
  }),
  hooks: {
    "build:done": (wxt) => {
      try {
        const outDir = wxt.config.outDir; // .output/chrome-mv3
        mkdirSync(outDir, { recursive: true });
        writeFileSync(
          resolve(outDir, "build-stamp.json"),
          JSON.stringify({ stamp: BUILD_STAMP }),
        );
      } catch {
        // non-fatal: self-reload just won't have a served stamp this build.
      }
    },
  },
  manifest: {
    name: "Noelle Chrome Bridge",
    description:
      "Claude's hands on Chrome — executes control ops from the local Chrome Bridge.",
    version: "0.0.1",
    // Full control of the operator's own Chrome (loaded unpacked in dev):
    //  - tabs/scripting: default control path (no debugger slot, so it can never
    //    collide with a live actuator run)
    //  - debugger: opt-in, guarded CDP passthrough
    //  - management: list/reload/enable extensions (to debug the actuators)
    //  - storage/alarms: config + the poll heartbeat
    permissions: [
      "tabs",
      "scripting",
      "debugger",
      "management",
      "storage",
      "alarms",
    ],
    // <all_urls> so an agent can drive ANY tab; 127.0.0.1/localhost is the
    // bridge. This extension lives only in the operator's own browser.
    host_permissions: ["<all_urls>", "http://127.0.0.1/*", "http://localhost/*"],
  },
});

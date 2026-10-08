import { defineConfig } from "wxt";
import { ACTUATOR_EXTENSION_NAMES, actuatorApiHostPermissions } from "@noelle/contracts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// One stamp per build, embedded in the bundle (__BUILD_STAMP__) AND written to
// .output/chrome-mv3/build-stamp.json for api-vm to serve. The pair is what
// lets the running (unpacked) extension detect that a newer build landed on
// disk and chrome.runtime.reload() itself — reload() re-reads the unpacked dir,
// same as clicking Reload on chrome://extensions.
const BUILD_STAMP = new Date().toISOString();

export default defineConfig({
  vite: () => ({ define: { __BUILD_STAMP__: JSON.stringify(BUILD_STAMP) } }),
  hooks: {
    "build:done": async (wxt) => {
      await writeFile(
        join(wxt.config.outDir, "build-stamp.json"),
        JSON.stringify({ stamp: BUILD_STAMP }) + "\n",
      );
    },
  },
  manifest: {
    name: ACTUATOR_EXTENSION_NAMES["x-actuator"],
    description: "Vega's hands — actuates approved X replies from your own tab.",
    version: "0.0.1",
    permissions: ["storage", "alarms", "debugger", "tabs"],
    // Scoped tight to shrink the extension's fingerprintable footprint: only
    // x.com / twitter.com (the actuation target) plus the local api-vm. No
    // http://*/* or https://*/* wildcards. http://127.0.0.1/* is required
    // separately from localhost because Chrome's SW may resolve "localhost" to
    // IPv6 ::1, which the IPv4 api-vm doesn't answer, so the working API host is
    // http://127.0.0.1:18791. If the API base URL is ever pointed at a remote
    // (tunnel) host, add that specific origin here rather than a wildcard.
    // The remote origins mirror the LinkedIn actuator's: the operator's backend
    // reached privately over Tailscale (MagicDNS name + its stable Tailscale IP,
    // api-vm on :18791) and the prod tunnel. SPECIFIC origins only, never a
    // tailnet-wide wildcard. Without them, retargeting the options API base URL at
    // a remote host makes every background fetch fail silently — fetchQueue throws
    // and health() collapses to null, which passesAutoStartSafety treats as
    // fail-closed, so auto-start and auto-drain never fire again.
    host_permissions: [
      "https://x.com/*",
      "https://twitter.com/*",
      ...actuatorApiHostPermissions(process.env.NOELLE_ACTUATOR_API_ORIGINS),
    ],
  },
});

// MAIN-world content script on <all_urls>. Its ONLY job is to make page.console
// actually capture the page's own console output.
//
// Why a second, MAIN-world script: each extension gets its own isolated world, so
// wrapping console in the isolated content script (content.ts) captures only the
// bridge's own logs — never the page's, nor an actuator extension's. The page's
// real console lives in the MAIN world. Inline <script> injection is blocked by the
// strict CSP on x.com/linkedin.com, so the CSP-proof way to run in the MAIN world
// is a manifest-declared world:"MAIN" content script (this file). It wraps the
// page console and forwards each entry to the isolated world via window.postMessage,
// where content.ts buffers it. MAIN-world scripts can't use chrome.* — postMessage
// is the only bridge, which is why the two scripts are split this way.
//
// Fully defensive: it always calls the original console, and never throws.
import { defineContentScript } from "wxt/sandbox";

export default defineContentScript({
  matches: ["<all_urls>"],
  world: "MAIN",
  runAt: "document_start",
  allFrames: false,
  main() {
    function safeStr(a: unknown): string {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    }

    try {
      for (const level of ["log", "warn", "error", "info", "debug"] as const) {
        const orig = console[level];
        if (typeof orig !== "function") continue;
        console[level] = function (...args: unknown[]) {
          try {
            window.postMessage(
              { __noelleBridgeConsole: true, level, args: args.map(safeStr) },
              "*",
            );
          } catch {
            // ignore — forwarding is best-effort
          }
          try {
            return (orig as (...a: unknown[]) => unknown).apply(console, args);
          } catch {
            // preserve original behavior even if it somehow throws
          }
        };
      }
    } catch {
      // if wrapping fails the page is simply un-captured; never break the page
    }
  },
});

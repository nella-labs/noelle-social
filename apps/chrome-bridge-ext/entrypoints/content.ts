// Isolated-world content script on <all_urls>. Two jobs:
//   1. Wake the MV3 service worker every ~1.5s with {cmd:"poll-tick"} so it polls
//      the bridge (the SW is evicted after ~30s idle; its own timers are
//      unreliable — the content-script interval is the dependable heartbeat).
//   2. Keep a bounded console ring buffer and answer {cmd:"get-console"} from the
//      SW (the page.console op). The buffer is fed by BOTH this isolated world's
//      console AND the page's MAIN-world console, forwarded here by the
//      page-console content script via window.postMessage.
//
// Everything is defensive: a content script must never throw into the page.
import { defineContentScript } from "wxt/sandbox";

const POLL_TICK_MS = 1_500;
const RING_CAP = 500;

type Level = "log" | "warn" | "error" | "info" | "debug";
interface ConsoleLine {
  level: Level;
  at: number;
  text: string;
}

// Marker for MAIN-world console entries forwarded via window.postMessage.
interface ForwardedConsole {
  __noelleBridgeConsole: true;
  level: Level;
  args: string[];
}

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  allFrames: false,
  main() {
    const ring: ConsoleLine[] = [];

    function stringifyArg(a: unknown): string {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    }

    function push(level: Level, args: unknown[]): void {
      try {
        const text = args.map(stringifyArg).join(" ").slice(0, 2000);
        ring.push({ level, at: Date.now(), text });
        if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
      } catch {
        // never throw into the page
      }
    }

    // Wrap this isolated world's console (captures the bridge's own content-script
    // logs; the page's own console is captured via the MAIN-world forwarder below).
    try {
      for (const level of ["log", "warn", "error", "info", "debug"] as const) {
        const orig = console[level]?.bind(console);
        if (!orig) continue;
        console[level] = (...args: unknown[]) => {
          push(level, args);
          try {
            orig(...args);
          } catch {
            // swallow
          }
        };
      }
    } catch {
      // if console wrapping fails, the ring simply stays empty for this world
    }

    // Buffer page (MAIN-world) console entries forwarded by page-console.content.ts.
    window.addEventListener("message", (ev: MessageEvent) => {
      if (ev.source !== window) return;
      const d = ev.data as Partial<ForwardedConsole> | null;
      if (!d || d.__noelleBridgeConsole !== true) return;
      push((d.level as Level) ?? "log", Array.isArray(d.args) ? d.args : []);
    });

    // Answer the SW's page.console query with the buffered lines.
    chrome.runtime.onMessage.addListener(
      (msg: { cmd?: string; sinceMs?: number; limit?: number }, _sender, reply) => {
        if (msg?.cmd !== "get-console") return false;
        const sinceMs = typeof msg.sinceMs === "number" ? msg.sinceMs : 0;
        const limit = typeof msg.limit === "number" ? msg.limit : 100;
        const lines = ring.filter((l) => l.at >= sinceMs).slice(-limit);
        reply(lines);
        return true;
      },
    );

    // The wake heartbeat.
    setInterval(() => {
      chrome.runtime.sendMessage({ cmd: "poll-tick" }).catch(() => {
        // SW busy / no receiver — the next tick retries.
      });
    }, POLL_TICK_MS);
  },
});

// Fail-open mirror of the actuator's lifecycle + error logs and a periodic
// liveness heartbeat to the local Chrome Bridge sink (see docs/chrome-bridge.md).
//
// This is observability ONLY. It never touches the send/actuation path: every
// call is best-effort and every failure is swallowed, so the bridge being down
// (or absent entirely) can never affect a run. Disable instantly by setting
// `bridgeSink: false` on the actuator config.
//
// The bridge listens loopback-only at 127.0.0.1:18792 and its /ingest/* routes
// are unauthenticated (the loopback bind is the trust boundary), so no token is
// needed here. host_permissions already include http://127.0.0.1/*.

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:18792";
const SOURCE = "x-actuator";
const RING_MAX = 200; // cap the in-memory buffer so a long-down bridge can't grow it
const PULSE_THROTTLE_MS = 60_000; // heartbeat at most once a minute

type SinkConfig = { bridgeUrl?: string; bridgeSink?: boolean };
type SinkState = "idle" | "running" | "draining" | "paused" | "error";

type BufferedLog = {
  level: "debug" | "info" | "warn" | "error";
  at: string;
  msg: string;
  data?: Record<string, unknown>;
};

let buffer: BufferedLog[] = [];
let lastPulseAt = 0;

function bridgeUrl(cfg: SinkConfig): string {
  return cfg.bridgeUrl ?? DEFAULT_BRIDGE_URL;
}

function buildStamp(): string | undefined {
  return typeof __BUILD_STAMP__ === "string" ? __BUILD_STAMP__ : undefined;
}

// fetch MUST be bound to the realm global — an unbound reference throws
// "Illegal invocation" in the service worker (same note as ActuatorApi).
function boundFetch(): typeof fetch {
  return globalThis.fetch.bind(globalThis);
}

/** Buffer a structured log line for the next flush. Never throws. */
export function sinkLog(
  level: BufferedLog["level"],
  msg: string,
  data?: Record<string, unknown>,
): void {
  try {
    buffer.push({ level, at: new Date().toISOString(), msg, data });
    if (buffer.length > RING_MAX) buffer.splice(0, buffer.length - RING_MAX);
  } catch {
    /* never let logging break the caller */
  }
}

/** Ship buffered logs to the bridge. Best-effort; drops on failure. */
export async function flushLogs(cfg: SinkConfig): Promise<void> {
  if (cfg.bridgeSink === false) return;
  if (buffer.length === 0) return;
  const entries = buffer;
  buffer = [];
  try {
    await boundFetch()(`${bridgeUrl(cfg)}/ingest/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: SOURCE, entries }),
    });
  } catch {
    // Drop on failure rather than re-buffering, so a long-down bridge can't grow
    // memory unbounded. The doctor mainly relies on the heartbeat anyway.
  }
}

/** Post a liveness heartbeat. Best-effort; swallows all errors. */
export async function heartbeat(
  cfg: SinkConfig,
  state: SinkState,
  detail?: Record<string, unknown>,
): Promise<void> {
  if (cfg.bridgeSink === false) return;
  try {
    await boundFetch()(`${bridgeUrl(cfg)}/ingest/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: SOURCE,
        at: new Date().toISOString(),
        state,
        detail: { ...detail, build_stamp: buildStamp() },
      }),
    });
  } catch {
    /* fail-open */
  }
}

/**
 * One combined pulse: heartbeat (with current run state) + flush buffered logs.
 * Throttled so the 30s tick alarm doesn't POST every tick; the 5-min autonomy
 * alarm always gets through because `force` is passed there. Call this from the
 * alarm handlers — it is entirely fire-and-forget.
 */
export async function bridgePulse(
  cfg: SinkConfig,
  state: SinkState,
  detail?: Record<string, unknown>,
  force = false,
): Promise<void> {
  if (cfg.bridgeSink === false) return;
  const now = Date.now();
  if (!force && now - lastPulseAt < PULSE_THROTTLE_MS) return;
  lastPulseAt = now;
  await Promise.allSettled([heartbeat(cfg, state, detail), flushLogs(cfg)]);
}

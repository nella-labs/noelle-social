import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The chrome-bridge-ext build stamp lives at a sibling app, resolved RELATIVE TO
// THIS MODULE (not process.cwd()). Under pm2 the app's cwd is
// REPO/apps/chrome-bridge, so a cwd-relative default would point at the
// non-existent REPO/apps/chrome-bridge/apps/chrome-bridge-ext/... and GET
// /ext/build would return {stamp:null} forever (breaking ext self-reload). This
// module (src/env.ts in dev, dist/env.js in prod) sits at
// REPO/apps/chrome-bridge/{src,dist}/env.js, so "../../chrome-bridge-ext/..."
// resolves correctly in both.
const DEFAULT_EXT_STAMP_PATH = fileURLToPath(
  new URL("../../chrome-bridge-ext/dist-unpacked/build-stamp.json", import.meta.url),
);

// Config for the Chrome Bridge control server, read once from process.env.
//
// The server binds 127.0.0.1 ONLY (fixed in index.ts) — the loopback bind is
// the trust boundary for the ext-transport (/ext/*) and ingest (/ingest/*)
// routes, which carry no bearer by design (docs/chrome-bridge.md). The
// caller-facing routes (/op, /logs, /heartbeats) additionally require
// NOELLE_BRIDGE_TOKEN. When that is unset the server still boots (so local
// bring-up of the ext + ingest sink works) but every caller route fails closed
// with 500 "no token configured" — see server.ts.

export interface BridgeEnv {
  port: number;
  // null when NOELLE_BRIDGE_TOKEN is unset — caller routes then fail closed.
  token: string | null;
  logDir: string;
  opTimeoutMs: number;
  logMaxBytes: number;
  // Per-source stale threshold: a flat default plus optional overrides. The
  // /heartbeats route computes `stale` against staleMsFor(env, source).
  staleMsDefault: number;
  staleMsOverrides: Record<string, number>;
  extStampPath: string;
}

function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

// NOELLE_BRIDGE_STALE_MS is a "default map": either a bare integer (the default
// threshold for every source) or a JSON object of per-source overrides that may
// carry a `default` key, e.g. {"default":600000,"x-actuator":300000}. Anything
// unparseable falls back to 600_000.
function parseStaleMs(raw: string | undefined): {
  staleMsDefault: number;
  staleMsOverrides: Record<string, number>;
} {
  const FALLBACK = 600_000;
  const trimmed = raw?.trim();
  if (!trimmed) return { staleMsDefault: FALLBACK, staleMsOverrides: {} };
  if (/^\d+$/.test(trimmed)) return { staleMsDefault: Number(trimmed), staleMsOverrides: {} };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const overrides: Record<string, number> = {};
      let def = FALLBACK;
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n) || n < 0) continue;
        if (k === "default") def = Math.floor(n);
        else overrides[k] = Math.floor(n);
      }
      return { staleMsDefault: def, staleMsOverrides: overrides };
    }
  } catch {
    // fall through to the fallback below
  }
  return { staleMsDefault: FALLBACK, staleMsOverrides: {} };
}

let cached: BridgeEnv | undefined;

export function loadEnv(): BridgeEnv {
  if (cached) return cached;
  const token = process.env.NOELLE_BRIDGE_TOKEN;
  const logDirRaw = process.env.NOELLE_BRIDGE_LOG_DIR?.trim();
  const stampRaw = process.env.NOELLE_BRIDGE_EXT_STAMP_PATH?.trim();
  const { staleMsDefault, staleMsOverrides } = parseStaleMs(process.env.NOELLE_BRIDGE_STALE_MS);
  cached = {
    port: intEnv("NOELLE_BRIDGE_PORT", 18792),
    token: token && token.length > 0 ? token : null,
    logDir: logDirRaw && logDirRaw.length > 0 ? logDirRaw : path.join(os.homedir(), ".noelle", "logs", "actuators"),
    opTimeoutMs: intEnv("NOELLE_BRIDGE_OP_TIMEOUT_MS", 20_000),
    logMaxBytes: intEnv("NOELLE_BRIDGE_LOG_MAX_BYTES", 5_000_000),
    staleMsDefault,
    staleMsOverrides,
    extStampPath: stampRaw && stampRaw.length > 0 ? stampRaw : DEFAULT_EXT_STAMP_PATH,
  };
  return cached;
}

export function staleMsFor(env: BridgeEnv, source: string): number {
  return env.staleMsOverrides[source] ?? env.staleMsDefault;
}

// Test-only escape hatch (vitest sets process.env per test) — clears the
// memoized parse so a re-load picks up the new values.
export function resetEnvForTests(): void {
  cached = undefined;
}

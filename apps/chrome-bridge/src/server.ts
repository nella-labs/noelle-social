import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import {
  ChromeOpSchema,
  ExtEventSchema,
  ExtHelloSchema,
  HeartbeatSchema,
  LogIngestSchema,
  LogLevelSchema,
  OpResultReportSchema,
  type BridgeHealth,
  type ExtPollResponse,
  type LogLevel,
} from "@noelle/contracts";
import { staleMsFor, type BridgeEnv } from "./env.js";
import type { Sink } from "./sink.js";
import type { OpQueue } from "./op-queue.js";
import type { Logger } from "./logger.js";

// Kept in lockstep with apps/chrome-bridge/package.json version. Surfaced on
// GET /health so callers can spot a stale bridge.
const BRIDGE_VERSION = "0.0.1-alpha.0";

export interface ServerDeps {
  env: BridgeEnv;
  sink: Sink;
  opQueue: OpQueue;
  logger: Logger;
  startedAt: number;
}

export function createServer(deps: ServerDeps): Hono {
  const { env, sink, opQueue, logger, startedAt } = deps;
  const app = new Hono();

  // CORS + Private Network Access, SCOPED to extension origins only.
  //
  // The chrome-bridge-ext + the actuators fetch this loopback server cross-origin
  // from a chrome-extension:// origin. Chrome gates a loopback request behind a
  // Private-Network-Access grant (Access-Control-Allow-Private-Network). We emit
  // that grant + reflect the origin ONLY for chrome-extension:// callers.
  //
  // Emitting Allow-Private-Network:true for ANY origin (the api-vm mirror) is
  // exactly what would let a public website the operator is browsing reach these
  // loopback routes via PNA — the /ext/* and /ingest/* routes have no bearer, so
  // a page could drain the op queue or forge results. Scoping the grant to
  // extension origins closes that: a website's preflight gets no PNA grant, so
  // Chrome blocks the request before it reaches us. (The bearer still guards
  // /op, /logs, /heartbeats regardless.)
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    const isExt = !!origin && origin.startsWith("chrome-extension://");
    const reqHeaders = c.req.header("access-control-request-headers") ?? "authorization,content-type";
    if (c.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...(isExt
            ? {
                "access-control-allow-origin": origin,
                "access-control-allow-private-network": "true",
              }
            : {}),
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": reqHeaders,
          "access-control-max-age": "600",
          vary: "origin",
        },
      });
    }
    await next();
    if (isExt) {
      c.header("access-control-allow-origin", origin);
      c.header("access-control-allow-private-network", "true");
    }
    c.header("vary", "origin");
  });

  // Light request log to stderr; skip the high-frequency ext poll + health so
  // a ~1.5s poll loop doesn't drown the log.
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const p = c.req.path;
    if (p === "/ext/poll" || p === "/health") return;
    logger.info({ method: c.req.method, path: p, status: c.res.status, ms: Date.now() - start }, "req");
  });

  // Bearer auth for the caller-facing routes. Fails CLOSED with 500 when no
  // token is configured; timing-safe compare (length-guard first) mirrors
  // apps/api-vm/src/middleware/actuator.ts.
  const bearer: MiddlewareHandler = async (c, next) => {
    if (env.token === null) {
      return c.json({ ok: false, error: "no token configured" }, 500);
    }
    const header = c.req.header("authorization") ?? c.req.header("Authorization");
    if (!header || !header.toLowerCase().startsWith("bearer ")) {
      return c.json({ ok: false, error: "missing bearer token" }, 401);
    }
    const token = header.slice("bearer ".length).trim();
    const a = Buffer.from(token);
    const b = Buffer.from(env.token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return c.json({ ok: false, error: "invalid token" }, 401);
    }
    await next();
  };

  // --- caller-facing --------------------------------------------------------

  app.get("/health", (c) => {
    const st = opQueue.status();
    const health: BridgeHealth = {
      ok: true,
      version: BRIDGE_VERSION,
      ext_connected: st.connected,
      sources: sink.sources(),
      uptime_ms: Date.now() - startedAt,
    };
    if (st.extVersion) health.ext_version = st.extVersion;
    if (st.chromeVersion) health.chrome_version = st.chromeVersion;
    return c.json(health);
  });

  app.post("/op", bearer, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ChromeOpSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: `invalid op: ${parsed.error.message}` }, 400);
    }
    if (!opQueue.isConnected()) {
      return c.json({ ok: false, error: "extension not connected" }, 503);
    }
    // Always 200 with the ChromeOpResult — including the timeout result — so
    // every caller sees one uniform shape (docs/chrome-bridge.md notes 504, but
    // returning the failed result at 200 keeps callers on a single code path).
    const result = await opQueue.enqueue(parsed.data);
    return c.json(result, 200);
  });

  app.get("/logs", bearer, (c) => {
    const q = c.req.query();
    const levelParse = LogLevelSchema.safeParse(q.level);
    const result = sink.queryLogs({
      source: q.source || undefined,
      sinceMs: numOr(q.sinceMs),
      level: levelParse.success ? (levelParse.data as LogLevel) : undefined,
      grep: q.grep || undefined,
      limit: numOr(q.limit),
    });
    return c.json(result);
  });

  app.get("/heartbeats", bearer, (c) => {
    const now = Date.now();
    const sources = sink.getHeartbeats(now, (s) => staleMsFor(env, s));
    return c.json({ sources });
  });

  // --- extension transport (loopback-open, no bearer) -----------------------

  app.post("/ext/hello", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ExtHelloSchema.safeParse(body);
    if (!parsed.success) return c.json({ ok: false, error: "invalid hello" }, 400);
    opQueue.hello(parsed.data);
    logger.info({ ext: parsed.data }, "ext hello");
    return c.json({ ok: true });
  });

  app.get("/ext/poll", (c) => {
    const resp: ExtPollResponse = { requests: opQueue.drainForExt() };
    return c.json(resp);
  });

  app.post("/ext/result", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = OpResultReportSchema.safeParse(body);
    if (!parsed.success) return c.json({ ok: false, error: "invalid result" }, 400);
    opQueue.report(parsed.data.id, parsed.data.result);
    return c.json({ ok: true });
  });

  app.post("/ext/event", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ExtEventSchema.safeParse(body);
    if (!parsed.success) return c.json({ ok: false, error: "invalid event" }, 400);
    const ev = parsed.data;
    if (ev.kind === "console") {
      const src = c.req.query("source") || asString(ev.data.source) || "chrome-bridge-ext";
      const msg = asString(ev.data.text) ?? asString(ev.data.message) ?? "console";
      // Never throws — the sink swallows fs errors and validates internally.
      sink.appendLogs({
        source: src,
        entries: [{ level: coerceLevel(ev.data.level), at: ev.at, msg, data: ev.data }],
      });
    }
    return c.json({ ok: true });
  });

  app.get("/ext/build", (c) => {
    // build-stamp.json is { stamp: "<ISO>" }; unwrap to { stamp: <string|null> }
    // — byte-identical to api-vm's GET /api/actuator/extension-build so the ext's
    // self-reload compares its embedded stamp against the same shape.
    try {
      const raw = JSON.parse(readFileSync(env.extStampPath, "utf8")) as { stamp?: unknown };
      return c.json({ stamp: typeof raw.stamp === "string" ? raw.stamp : null });
    } catch {
      return c.json({ stamp: null });
    }
  });

  // --- ingest (loopback-open, no bearer) ------------------------------------

  app.post("/ingest/logs", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = LogIngestSchema.safeParse(body);
    if (!parsed.success) return c.json({ ok: false, error: "invalid ingest", stored: 0 }, 400);
    const { stored } = sink.appendLogs(parsed.data);
    return c.json({ ok: true, stored });
  });

  app.post("/ingest/heartbeat", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = HeartbeatSchema.safeParse(body);
    if (!parsed.success) return c.json({ ok: false, error: "invalid heartbeat" }, 400);
    sink.setHeartbeat(parsed.data);
    return c.json({ ok: true });
  });

  app.notFound((c) => c.json({ ok: false, error: "not_found" }, 404));
  app.onError((err, c) => {
    logger.error({ err: String(err) }, "unhandled error");
    return c.json({ ok: false, error: "internal_error" }, 500);
  });

  return app;
}

function numOr(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function coerceLevel(v: unknown): LogLevel {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (s === "error" || s === "err") return "error";
  if (s === "warn" || s === "warning") return "warn";
  if (s === "debug" || s === "verbose" || s === "trace") return "debug";
  return "info";
}

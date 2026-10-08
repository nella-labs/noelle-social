import { serve } from "@hono/node-server";
import { loadEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { Sink } from "./sink.js";
import { OpQueue } from "./op-queue.js";
import { createServer } from "./server.js";

const env = loadEnv();
const logger = createLogger();

if (env.token === null) {
  logger.warn(
    "NOELLE_BRIDGE_TOKEN is not set — the server boots, but /op, /logs and /heartbeats reject with 500 until a token is configured",
  );
}

const sink = new Sink({ logDir: env.logDir, maxBytes: env.logMaxBytes });
const opQueue = new OpQueue({ opTimeoutMs: env.opTimeoutMs });
const startedAt = Date.now();
const app = createServer({ env, sink, opQueue, logger, startedAt });

// Loopback ONLY — the 127.0.0.1 bind is the trust boundary for the no-bearer
// ext-transport + ingest routes. Never bind 0.0.0.0.
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: env.port }, () => {
  logger.info(`chrome-bridge listening on 127.0.0.1:${env.port}`);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  // Hard-exit backstop if close() hangs on an open connection.
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

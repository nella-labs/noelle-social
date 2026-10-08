import pino from "pino";

// pino → stderr (fd 2), so stdout stays clean and pm2 / journald ingest the
// JSON lines straight in. One object per line, ISO timestamps. Mirrors the
// reddit-intern logger idiom, minus the worker_id (the bridge is one process).
export function createLogger() {
  return pino(
    {
      base: { kind: "chrome-bridge" },
      timestamp: pino.stdTimeFunctions.isoTime,
      level: process.env.LOG_LEVEL ?? "info",
      formatters: {
        level: (label) => ({ level: label }),
      },
    },
    pino.destination(2),
  );
}

export type Logger = ReturnType<typeof createLogger>;

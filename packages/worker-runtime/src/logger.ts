import pino from "pino";

// JSON logs, one object per line, includes `kind`, `worker_id`, `level`.
// pm2 (native runtime) and journald (the retired VM path) both ingest these
// straight in with no extra config.
export function createLogger(opts: {
  kind: string;
  workerId: string;
}) {
  return pino({
    base: { kind: opts.kind, worker_id: opts.workerId },
    timestamp: pino.stdTimeFunctions.isoTime,
    level: process.env.LOG_LEVEL ?? "info",
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;

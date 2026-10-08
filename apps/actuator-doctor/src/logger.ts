import pino from "pino";

// journald-friendly JSON: one object per line, includes `kind`, `worker_id`,
// `level`. pm2 / journald ingest these straight in with no extra config.
// (Copied from apps/reddit-intern/src/lib/logger.ts to keep the doctor's log
// shape identical to the workers it watches.)
export function createLogger(opts: { kind: string; workerId: string }) {
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

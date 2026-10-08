import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  BridgeSourceSchema,
  HeartbeatSchema,
  LogEntrySchema,
  LogIngestSchema,
  type Heartbeat,
  type HeartbeatStatus,
  type LogEntry,
  type LogLevel,
  type LogQueryResult,
} from "@noelle/contracts";

const HEARTBEATS_FILE = "heartbeats.json";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5_000;

export interface LogQuery {
  source?: string;
  sinceMs?: number;
  level?: LogLevel;
  grep?: string;
  limit?: number;
}

// The log + heartbeat sink. Append-only ndjson per source (size-capped, one .1
// backup), plus the latest heartbeat per source held in memory and mirrored to
// heartbeats.json. Every fs touch is wrapped so an ingest can NEVER throw back
// out to a caller; inputs are validated with the contract zod schemas.
export class Sink {
  private readonly logDir: string;
  private readonly maxBytes: number;
  private readonly heartbeats = new Map<string, Heartbeat>();
  private readonly sourcesSeen = new Set<string>();

  constructor(opts: { logDir: string; maxBytes: number }) {
    this.logDir = opts.logDir;
    this.maxBytes = opts.maxBytes;
    try {
      mkdirSync(this.logDir, { recursive: true });
    } catch {
      // best-effort; a later append/write just fails closed (returns 0/false).
    }
    this.loadHeartbeats();
  }

  // --- ingest ---------------------------------------------------------------

  appendLogs(input: unknown): { stored: number } {
    const parsed = LogIngestSchema.safeParse(input);
    if (!parsed.success) return { stored: 0 };
    const { source, entries } = parsed.data;
    try {
      const file = this.sourceFile(source);
      const chunk = entries.map((e) => JSON.stringify({ source, ...e })).join("\n") + "\n";
      const chunkBytes = Buffer.byteLength(chunk);
      let currentSize = 0;
      try {
        currentSize = statSync(file).size;
      } catch {
        currentSize = 0; // no file yet
      }
      if (currentSize > 0 && currentSize + chunkBytes > this.maxBytes) {
        this.rotate(file);
      }
      appendFileSync(file, chunk);
      this.sourcesSeen.add(source);
      return { stored: entries.length };
    } catch {
      return { stored: 0 };
    }
  }

  setHeartbeat(input: unknown): { ok: boolean } {
    const parsed = HeartbeatSchema.safeParse(input);
    if (!parsed.success) return { ok: false };
    this.heartbeats.set(parsed.data.source, parsed.data);
    this.sourcesSeen.add(parsed.data.source);
    this.persistHeartbeats();
    return { ok: true };
  }

  // --- read -----------------------------------------------------------------

  getHeartbeats(now: number, staleMsFor: (source: string) => number): HeartbeatStatus[] {
    const out: HeartbeatStatus[] = [];
    for (const [source, hb] of this.heartbeats) {
      const at = Date.parse(hb.at);
      const age = Number.isFinite(at) ? now - at : Number.MAX_SAFE_INTEGER;
      out.push({ ...hb, age_ms: age, stale: age > staleMsFor(source) });
    }
    out.sort((a, b) => a.source.localeCompare(b.source));
    return out;
  }

  queryLogs(q: LogQuery): LogQueryResult {
    // Validate the source slug on the READ path too (the write path already does
    // via LogIngestSchema). Without this, `?source=../../../etc/foo` would make
    // sourceFile() path.join out of logDir and read an arbitrary *.ndjson.
    if (q.source !== undefined && !BridgeSourceSchema.safeParse(q.source).success) {
      return { source: q.source, count: 0, entries: [] };
    }
    const limit = clamp(q.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const collected: LogEntry[] = [];
    for (const file of this.filesForQuery(q.source)) {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue; // missing/unreadable file — skip
      }
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          continue; // torn/partial line — skip
        }
        const entry = LogEntrySchema.safeParse(obj);
        if (entry.success) collected.push(entry.data);
      }
    }
    // Sort chronologically (oldest→newest); Node's sort is stable, so equal
    // timestamps keep file/read order. Then filter, then keep the newest `limit`.
    collected.sort((a, b) => tsOf(a.at) - tsOf(b.at));
    const capped = collected.filter((e) => matches(e, q)).slice(-limit);
    const result: LogQueryResult = { count: capped.length, entries: capped };
    if (q.source) result.source = q.source;
    return result;
  }

  sources(): string[] {
    return [...this.sourcesSeen].sort();
  }

  // --- internals ------------------------------------------------------------

  private sourceFile(source: string): string {
    return path.join(this.logDir, `${source}.ndjson`);
  }

  private filesForQuery(source?: string): string[] {
    if (source) {
      // .1 (older) first so the merge stays chronological across a rotation.
      const base = this.sourceFile(source);
      return [`${base}.1`, base];
    }
    // No source → every ndjson (+ rotated backup) in the dir, minus heartbeats.
    let names: string[];
    try {
      names = readdirSync(this.logDir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n !== HEARTBEATS_FILE && (n.endsWith(".ndjson") || n.endsWith(".ndjson.1")))
      .sort()
      .map((n) => path.join(this.logDir, n));
  }

  private rotate(file: string): void {
    try {
      renameSync(file, `${file}.1`); // overwrites any prior .1 (one backup kept)
    } catch {
      // rename failed (rare fs issue). Truncate to bound growth — otherwise the
      // file stays over maxBytes and EVERY subsequent append re-triggers rotation
      // + appends anyway, growing it without limit. Losing the current file's tail
      // on a persistent rename failure is the lesser evil.
      try {
        writeFileSync(file, "");
      } catch {
        // give up: nothing safe left to do without risking a throw into ingest.
      }
    }
  }

  private persistHeartbeats(): void {
    try {
      const obj: Record<string, Heartbeat> = {};
      for (const [source, hb] of this.heartbeats) obj[source] = hb;
      writeFileSync(path.join(this.logDir, HEARTBEATS_FILE), JSON.stringify(obj));
    } catch {
      // best-effort mirror; the in-memory map remains authoritative.
    }
  }

  private loadHeartbeats(): void {
    try {
      const raw = readFileSync(path.join(this.logDir, HEARTBEATS_FILE), "utf8");
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const v of Object.values(obj)) {
        const hb = HeartbeatSchema.safeParse(v);
        if (hb.success) {
          this.heartbeats.set(hb.data.source, hb.data);
          this.sourcesSeen.add(hb.data.source);
        }
      }
    } catch {
      // no prior heartbeats (fresh boot) — fine.
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function tsOf(at: string): number {
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : 0;
}

function matches(e: LogEntry, q: LogQuery): boolean {
  if (q.level && e.level !== q.level) return false;
  if (q.sinceMs !== undefined) {
    const t = Date.parse(e.at);
    if (!Number.isFinite(t) || t < q.sinceMs) return false;
  }
  if (q.grep) {
    const hay = `${e.msg} ${JSON.stringify(e.data ?? {})}`.toLowerCase();
    if (!hay.includes(q.grep.toLowerCase())) return false;
  }
  return true;
}

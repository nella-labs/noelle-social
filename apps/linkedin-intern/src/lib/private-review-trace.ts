import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DraftToVerify, DraftVerdict } from "@noelle/runtime";

const LEAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRACE_FILE = /^linkedin-[0-9a-f-]{36}\.json$/i;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 40_000;
const MAX_ATTEMPTS = 6;
const retentionTimers = new Map<string, NodeJS.Timeout>();

export interface PrivateReviewAttempt {
  attempt: number;
  drafts: DraftToVerify[];
  verdict: DraftVerdict;
}

export function privateReviewTraceEnabled(leadId: string, source: string | undefined): boolean {
  return source === "extension_observed"
    && LEAD_ID.test(leadId)
    && process.env.NOELLE_LINKEDIN_REVIEW_TRACE_LEAD_ID === leadId;
}

function bounded(value: string, maxBytes: number, redactions: string[]): string {
  let clean = value;
  for (const token of redactions) {
    if (token.length >= 3) clean = clean.replaceAll(token, "[redacted]");
  }
  let result = "";
  let size = 0;
  for (const character of clean) {
    const nextSize = Buffer.byteLength(character);
    if (size + nextSize > maxBytes) break;
    result += character;
    size += nextSize;
  }
  return result;
}

async function purgeExpired(directory: string, now: number): Promise<number | null> {
  if (!(await lstat(directory)).isDirectory()) throw new Error("private review trace directory is not a directory");
  let nextExpiry: number | null = null;
  for (const name of await readdir(directory)) {
    if (!TRACE_FILE.test(name)) continue;
    const path = join(directory, name);
    const stat = await lstat(path);
    if (!stat.isFile()) continue;
    if (stat.mtimeMs <= now - RETENTION_MS) await unlink(path);
    else nextExpiry = Math.min(nextExpiry ?? Infinity, stat.mtimeMs + RETENTION_MS);
  }
  return nextExpiry;
}

async function cleanupDirectory(directory: string): Promise<void> {
  const previous = retentionTimers.get(directory);
  if (previous) clearTimeout(previous);
  retentionTimers.delete(directory);
  try {
    const nextExpiry = await purgeExpired(directory, Date.now());
    if (nextExpiry !== null) {
      const timer = setTimeout(() => {
        retentionTimers.delete(directory);
        void cleanupDirectory(directory).catch(() => {});
      }, Math.max(1, nextExpiry - Date.now() + 1));
      timer.unref();
      retentionTimers.set(directory, timer);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Startup sweep also schedules expiry for files left by a prior worker process. */
export async function cleanupPrivateReviewTraces(): Promise<void> {
  await cleanupDirectory(join(homedir(), ".noelle", "private-review-traces"));
}

/** One selected browser lead only. This file never contains prompts, post text, or author fields. */
export async function writePrivateReviewTrace(args: {
  leadId: string;
  source: string | undefined;
  attempts: PrivateReviewAttempt[];
  redactions: string[];
}): Promise<void> {
  if (!privateReviewTraceEnabled(args.leadId, args.source)) return;

  const directory = join(homedir(), ".noelle", "private-review-traces");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error("private review trace directory is not a directory");
  await chmod(directory, 0o700);
  const now = Date.now();
  await purgeExpired(directory, now);

  const attempts = args.attempts.slice(-MAX_ATTEMPTS).map(({ attempt, drafts, verdict }) => ({
    attempt,
    drafts: drafts.filter((draft) => draft.kind === "reply").slice(0, 1).map((draft) => ({
      angle: draft.angle,
      body: bounded(draft.body, 2_000, args.redactions),
    })),
    verdict: {
      pass: verdict.pass,
      judgeOk: verdict.judgeOk === true,
      judgeProvider: verdict.judgeProvider ?? "none",
      scores: verdict.scores,
      reasons: verdict.reasons.slice(0, 8).map((reason) => bounded(reason, 256, args.redactions)),
      fix: verdict.fix === null ? null : bounded(verdict.fix, 512, args.redactions),
    },
  }));
  const filename = `linkedin-${args.leadId}.json`;
  let bytes = Buffer.from(JSON.stringify({ leadId: args.leadId, updatedAt: new Date(now).toISOString(), attempts }));
  while (bytes.length > MAX_FILE_BYTES && attempts.length > 1) {
    attempts.shift();
    bytes = Buffer.from(JSON.stringify({ leadId: args.leadId, updatedAt: new Date(now).toISOString(), attempts }));
  }
  if (bytes.length > MAX_FILE_BYTES) throw new Error("private review trace exceeds size bound");

  const path = join(directory, filename);
  const temporary = join(directory, `.${filename}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await cleanupDirectory(directory);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

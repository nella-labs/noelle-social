// Escalation — the OPTIONAL, OFF-BY-DEFAULT self-improvement path.
//
// When NOELLE_DOCTOR_AUTOFIX is on, an UNMATCHED fault (a probe that failed but
// which no signature covers) can spawn a headless `claude -p` to propose a NEW
// signature. The proposal is strictly validated and clamped before it joins the
// store. Safety, by construction:
//
//   * It only ever writes a Signature to signatures.json. It never edits code,
//     runs shell, or merges anything.
//   * A Signature's remediation ladder can only contain the fixed, safe
//     RemediationAction enum (reload_extension / reconnect_bridge /
//     restart_worker / engage_kill_switch [fail-closed, STOPS sending] /
//     page_human). None can post, send, or spend — so even a bad learned
//     signature cannot cause outbound harm.
//   * Every learned signature is clamped: origin="learned", low confidence, a
//     small maxPerHour, and its ladder is forced to end in page_human so a human
//     is always looped in.
//   * Rate-limited (NOELLE_DOCTOR_MAX_ESCALATIONS_PER_HOUR, default 2) and fully
//     fail-soft — any error just alerts + returns.
//
// DRYRUN never escalates. With AUTOFIX off (the default), maybeEscalate() is a
// no-op regardless of arguments.

import { spawn } from "node:child_process";
import {
  SignatureSchema,
  type DoctorTarget,
  type Incident,
  type ProbeResult,
  type Signature,
  type SignatureStore,
} from "@noelle/contracts";
import type { AlertFn } from "./alert.js";
import type { Env } from "./env.js";
import { httpGet } from "./http.js";
import { appendIncident } from "./incidents.js";
import type { Logger } from "./logger.js";
import { persistStore } from "./signatures.js";

export interface EscalateArgs {
  env: Env;
  store: SignatureStore;
  logger: Logger;
  alert: AlertFn;
  probes: ProbeResult[];
  // Targets already handled by a matching signature this tick — never escalate
  // those (they are known; the ladder is handling them).
  matchedTargets: Set<DoctorTarget>;
  nowIso: string;
}

// Rolling one-hour budget of escalations, in-process. Escalation spawns an LLM
// and mutates the store, so it is capped hard and independently of remediations.
const escalationTimes: number[] = [];
function withinBudget(env: Env, now: number): boolean {
  const cutoff = now - 3_600_000;
  while (escalationTimes.length && escalationTimes[0]! < cutoff) escalationTimes.shift();
  return escalationTimes.length < env.NOELLE_DOCTOR_MAX_ESCALATIONS_PER_HOUR;
}

export async function maybeEscalate(args?: EscalateArgs): Promise<void> {
  // No args (legacy call) or autofix off or dry-run => do nothing. This is the
  // default posture: the deterministic loop already handled everything it knows.
  if (!args) return;
  const { env, store, logger, alert, probes, matchedTargets, nowIso } = args;
  if (!env.NOELLE_DOCTOR_AUTOFIX || env.NOELLE_DOCTOR_DRYRUN) return;

  try {
    // Unmatched faults: failing probes whose target has no signature this tick.
    const unmatched = probes.filter((p) => !p.ok && !matchedTargets.has(p.target));
    if (unmatched.length === 0) return;

    // Skip any (target,check) a signature already references — the store already
    // knows about that surface; don't relearn it every hour.
    const covered = new Set(
      store.signatures.flatMap((s) => s.match.map((m) => `${m.target}:${m.check}`)),
    );
    const fresh = unmatched.filter((p) => !covered.has(`${p.target}:${p.check}`));
    if (fresh.length === 0) return;

    if (!withinBudget(env, Date.now())) {
      logger.warn({ pending: fresh.length }, "escalation budget exhausted this hour; paging instead");
      await alert(
        env.NOELLE_DOCTOR_ALERT_CATEGORY,
        `[doctor] ${fresh.length} unknown fault(s) but escalation budget spent — needs a human look`,
      );
      return;
    }

    // The target we escalate for (the first fresh fault). Its recent logs give
    // the model context beyond the bare probe.
    const target = fresh[0]!.target;
    const logs = await recentLogs(env, target).catch(() => [] as unknown[]);

    const proposal = await proposeSignature(env, fresh, logs, logger);
    const sig = proposal ? sanitizeLearnedSignature(proposal, fresh, store, nowIso) : null;

    escalationTimes.push(Date.now());

    if (!sig) {
      // The model declined or produced something invalid — record + page, but
      // NEVER apply an unvalidated signature.
      await alert(
        env.NOELLE_DOCTOR_ALERT_CATEGORY,
        `[doctor] unknown fault on ${target} (${fresh.map((p) => p.check).join(",")}); escalation produced no usable signature — needs a human look`,
      );
      appendIncident(env, escalationIncident(target, fresh, nowIso, null, "escalation produced no usable signature"));
      logger.warn({ target }, "escalation yielded no valid signature");
      return;
    }

    store.signatures.push(sig);
    persistStore(env, store);
    appendIncident(env, escalationIncident(target, fresh, nowIso, sig.id, `learned signature ${sig.id}`));
    await alert(
      env.NOELLE_DOCTOR_ALERT_CATEGORY,
      `[doctor] LEARNED a new signature "${sig.id}" for ${target} (autofix). It ladders to ${sig.ladder.join(" -> ")}. Review it in signatures.json.`,
    );
    logger.warn({ signature: sig.id, target, ladder: sig.ladder }, "escalation learned a new signature");
  } catch (e) {
    // Fail-soft: a broken escalation must never take the loop down.
    logger.error({ err: String(e) }, "escalation failed");
    await args.alert(args.env.NOELLE_DOCTOR_ALERT_CATEGORY, `[doctor] escalation error: ${String(e).slice(0, 120)}`).catch(
      () => {},
    );
  }
}

// Pull the last ~40 log lines for a source from the bridge, for LLM context.
async function recentLogs(env: Env, target: DoctorTarget): Promise<unknown[]> {
  const url = `${env.NOELLE_BRIDGE_URL}/logs?source=${encodeURIComponent(target)}&limit=40`;
  const res = await httpGet(url, { timeoutMs: env.NOELLE_DOCTOR_HTTP_TIMEOUT_MS, token: env.NOELLE_BRIDGE_TOKEN });
  const body = res.json as { entries?: unknown[] } | null;
  return Array.isArray(body?.entries) ? body!.entries! : [];
}

// Spawn `claude -p`, feed a strict prompt on stdin, capture stdout. Returns the
// parsed JSON object the model emitted, or null on any failure / decline.
async function proposeSignature(
  env: Env,
  fresh: ProbeResult[],
  logs: unknown[],
  logger: Logger,
): Promise<unknown | null> {
  const prompt = buildPrompt(fresh, logs);
  const stdout = await runClaude(env, prompt).catch((e) => {
    logger.error({ err: String(e) }, "claude -p spawn failed");
    return null;
  });
  if (!stdout) return null;
  if (/\bINSUFFICIENT\b/.test(stdout) && !stdout.includes("{")) return null;
  return extractJsonObject(stdout);
}

function runClaude(env: Env, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(env.NOELLE_DOCTOR_CLAUDE_BIN, ["-p"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish(null);
    }, env.NOELLE_DOCTOR_ESCALATE_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.stdout?.on("data", (d) => {
      out += String(d);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0 ? out : null);
    });
    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

function buildPrompt(fresh: ProbeResult[], logs: unknown[]): string {
  const faults = fresh.map((p) => ({ target: p.target, check: p.check, reason: p.reason, metrics: p.metrics }));
  return [
    "You are the diagnosis stage of an automated ops watchdog (the Noelle actuator-doctor).",
    "The watchdog matches probe failures against known 'signatures' and remediates on a fixed ladder.",
    "A fault below matched NO known signature. Propose ONE new signature so the watchdog can handle it next time.",
    "",
    "Return ONLY a single JSON object (no prose, no code fences) with these fields:",
    "  id: kebab-case slug, title: string, description: string,",
    "  match: array of clauses, each { target, check, ok:false, reasonIncludes?: string, metric?: string, op?: one of gt|gte|lt|lte|eq|ne, value?: number|string|boolean },",
    "  ladder: ordered array from EXACTLY these actions: reload_extension, reconnect_bridge, restart_worker, engage_kill_switch, page_human,",
    "  maxPerHour: integer 1..3, confidence: number 0..1.",
    "Rules: every match clause MUST use one of the (target,check) pairs from the fault below and MUST assert ok:false.",
    "Prefer the least disruptive remediation that could plausibly fix THIS fault; ALWAYS end the ladder with page_human.",
    "engage_kill_switch STOPS the actuator from sending (it is a safe brake) — use it only when continuing to send would be harmful.",
    "If you cannot propose a sound signature, reply with the single word INSUFFICIENT.",
    "",
    "FAULT (unmatched probes this tick):",
    JSON.stringify(faults, null, 2),
    "",
    "RECENT LOGS for the affected source (most recent last, may be empty):",
    JSON.stringify(logs.slice(-40), null, 2),
  ].join("\n");
}

// Pull the first balanced {...} JSON object out of arbitrary model output.
// Exported for tests (pure).
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const SAFE_ACTIONS = new Set([
  "reload_extension",
  "reconnect_bridge",
  "restart_worker",
  "engage_kill_switch",
  "page_human",
]);

// Validate + clamp an LLM proposal into a safe learned Signature, or null.
// Exported for tests (pure): this is the guardrail between an LLM proposal and
// the live remediation store, so it is the most important thing to unit-test.
export function sanitizeLearnedSignature(
  proposal: unknown,
  fresh: ProbeResult[],
  store: SignatureStore,
  nowIso: string,
): Signature | null {
  if (typeof proposal !== "object" || proposal === null) return null;
  const raw = proposal as Record<string, unknown>;

  // The (target,check) surface the model is allowed to reference.
  const allowedPairs = new Set(fresh.map((p) => `${p.target}:${p.check}`));

  const ladderIn = Array.isArray(raw.ladder)
    ? raw.ladder.filter((a): a is string => typeof a === "string" && SAFE_ACTIONS.has(a))
    : [];

  const candidate = {
    id: typeof raw.id === "string" ? raw.id : "",
    title: typeof raw.title === "string" ? raw.title : "learned fault",
    description: typeof raw.description === "string" ? raw.description : "auto-learned by escalation",
    match: Array.isArray(raw.match) ? raw.match : [],
    ladder: ladderIn,
    maxPerHour: clampInt(raw.maxPerHour, 1, 3, 2),
    timesSeen: 0,
    timesResolved: 0,
    lastSeen: null,
    origin: "learned" as const,
    confidence: clampNum(raw.confidence, 0, 0.5, 0.3),
    learnedFrom: nowIso,
  };

  // Force the ladder to end in page_human (always loop a human in) and be non-empty.
  if (candidate.ladder.length === 0) candidate.ladder = ["page_human"];
  if (candidate.ladder[candidate.ladder.length - 1] !== "page_human") candidate.ladder.push("page_human");

  const parsed = SignatureSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const sig = parsed.data;

  // Reject if any clause references a (target,check) outside the actual fault —
  // prevents a hallucinated signature from matching unrelated probes. Also force
  // every clause to assert ok:false (a failure), never ok:true.
  if (sig.match.length === 0) return null;
  for (const clause of sig.match) {
    if (!allowedPairs.has(`${clause.target}:${clause.check}`)) return null;
    if (clause.ok !== false) clause.ok = false;
  }

  // Ensure a unique id (never clobber an existing signature).
  const existing = new Set(store.signatures.map((s) => s.id));
  let id = kebab(sig.id) || `learned-${sig.match[0]!.target}-${sig.match[0]!.check}`;
  if (existing.has(id)) id = `${id}-${nowIso.slice(0, 19).replace(/[:T]/g, "")}`;
  sig.id = id;

  return sig;
}

function escalationIncident(
  target: DoctorTarget,
  fresh: ProbeResult[],
  nowIso: string,
  signatureId: string | null,
  note: string,
): Incident {
  return {
    id: `${nowIso}::escalate::${target}`,
    at: nowIso,
    target,
    signatureId,
    summary: `escalation on ${target}: ${note}`,
    probes: fresh.filter((p) => p.target === target),
    actionTaken: "none",
    actionOk: null,
    verifiedAt: null,
    resolved: false,
    escalated: true,
    notes: note,
  };
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === "number" ? Math.round(v) : dflt;
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : dflt));
}
function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === "number" ? v : dflt;
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : dflt));
}
function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

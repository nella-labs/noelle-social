import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { DoctorReport, Incident } from "@noelle/contracts";
import type { Env } from "./env.js";

// The doctor's on-disk audit trail + status snapshot. All writes are fail-soft:
// a disk error must never crash a tick.
//
// incidents.ndjson is APPEND-ONLY and carries the full timeline — one line per
// state transition (open -> remediated -> verified/resolved), each a complete
// Incident sharing the incident id. A reader (CLI / MCP / escalation fixer)
// takes the last line per id as the current state. It rotates to a single .1
// backup past a size cap.
//
// last-report.json is the latest DoctorReport, rewritten every tick and read by
// `noelle doctor status` and the chrome_doctor MCP tool.

function incidentsPath(env: Env): string {
  return path.join(env.NOELLE_DOCTOR_STATE_DIR, "incidents.ndjson");
}

function reportPath(env: Env): string {
  return path.join(env.NOELLE_DOCTOR_STATE_DIR, "last-report.json");
}

function ensureDir(env: Env): void {
  mkdirSync(env.NOELLE_DOCTOR_STATE_DIR, { recursive: true });
}

function rotateIfNeeded(file: string, maxBytes: number): void {
  try {
    if (existsSync(file) && statSync(file).size > maxBytes) {
      renameSync(file, `${file}.1`); // keep exactly one backup (overwrites prior)
    }
  } catch {
    // ignore — rotation is best-effort
  }
}

export function appendIncident(env: Env, incident: Incident): void {
  try {
    ensureDir(env);
    const file = incidentsPath(env);
    rotateIfNeeded(file, env.NOELLE_DOCTOR_STATE_MAX_BYTES);
    appendFileSync(file, `${JSON.stringify(incident)}\n`);
  } catch {
    // swallow — the loop keeps running even if the audit trail can't be written
  }
}

// Verification / resolution outcomes are recorded by appending the updated
// Incident (same id) — the append-only timeline, latest-line-wins on read.
export function updateIncident(env: Env, incident: Incident): void {
  appendIncident(env, incident);
}

export function writeLastReport(env: Env, report: DoctorReport): void {
  try {
    ensureDir(env);
    const p = reportPath(env);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(report, null, 2));
    renameSync(tmp, p); // atomic — MCP/CLI never read a half-written report
  } catch {
    // swallow
  }
}

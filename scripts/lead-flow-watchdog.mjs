#!/usr/bin/env node
// Lead-flow watchdog — "did the scheduled run actually start, and are leads
// landing?" and, when the answer is no, fix it instead of waiting for someone
// to notice.
//
// Detect missed schedules and empty supply even when processes remain online.
//
// WHAT IT CHECKS, per intern with an enabled run_schedule:
//   1. Did a goal-run start within GRACE_MIN of its scheduled time?
//   2. Are leads landing at all (platform-wide, last LEAD_WINDOW_MIN)?
//   3. Is the run producing approvals?
//
// WHAT IT FIXES. Only one thing, and only the thing it can safely fix: an
// intern whose slot has passed with no run started is re-fired by setting
// run_schedule_next_at to now, which is exactly what the operator does by hand.
// It never starts an intern that has no schedule, never touches one mid-run,
// and never flips a send/auto-send switch.
//
// WHAT IT DOES NOT FIX. No leads landing at all is a SUPPLY problem (Apify
// tokens, rate limits, a dead actuator). Re-firing a run cannot fix that, so it
// pages instead of pretending.
//
// Each pass has a stop condition, a
// verification step and a failure alert.
//   - stop condition: one pass, then exit. Cadence belongs to launchd.
//   - verification: re-reads state after acting and reports what changed.
//   - failure alert: NOELLE_ALERT_CMD / pushover on anything it cannot fix.
//
// Usage:
//   node scripts/lead-flow-watchdog.mjs [--dry-run] [--json]

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const DRY = process.argv.includes("--dry-run");
const JSON_OUT = process.argv.includes("--json");

/** How long after a scheduled slot before a missing run counts as missed. */
const GRACE_MIN = 20;
/** Window used to decide whether leads are landing at all. */
const LEAD_WINDOW_MIN = 120;
/** Minimum leads in that window before we call supply healthy. */
const MIN_LEADS = 1;

const ALERT = process.env.NOELLE_ALERT_CMD;

async function psql(sql) {
  const { stdout } = await run("psql", ["-d", "postgres", "-Atq", "-c", sql], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

async function alert(msg) {
  console.error(`ALERT: ${msg}`);
  if (DRY || !ALERT) return;
  try {
    await run("/bin/sh", ["-c", `${ALERT} "$1"`, "noelle-alert", msg], { timeout: 20_000 });
  } catch (e) {
    console.error("  (alert command failed:", e instanceof Error ? e.message : e, ")");
  }
}

// One row per intern that HAS an enabled schedule. `slot_due_min` is how long
// ago today's slot passed (negative = still upcoming), computed in SQL so the
// timezone stored on the schedule is the one that decides.
const STATE_SQL = `
SELECT
  ai.id,
  ai.display_name,
  ai.role,
  ai.status,
  (ai.goal_target IS NOT NULL)                                  AS goal_active,
  coalesce(ai.drafter_enabled, false)                           AS drafter_on,
  (ai.run_schedule->>'goal')                                    AS goal,
  (ai.run_schedule->>'dailyTime')                               AS daily_time,
  round(extract(epoch FROM (now() - slot.at)) / 60)::int        AS slot_due_min,
  -- Did a goal-run START for TODAY's slot? A finished run ends as
  -- status='paused', goal_target=null, so "nothing running" is ALSO what a
  -- healthy completed run looks like. Without this the 13:00/19:00 sweeps
  -- re-fire every intern that already did its work.
  (ai.last_goal_started_at IS NOT NULL
     AND ai.last_goal_started_at >= slot.at)                    AS ran_for_this_slot,
  coalesce((
    SELECT count(*) FROM noelle.leads l
    WHERE l.platform = plat.p
      AND l.org_id = ai.org_id
      AND l.created_at > now() - interval '${LEAD_WINDOW_MIN} minutes'
  ), 0)                                                         AS leads_recent,
  coalesce((
    SELECT count(*) FROM noelle.approvals a
    WHERE a.agent_instance_id = ai.id
      AND a.created_at > now() - interval '${LEAD_WINDOW_MIN} minutes'
  ), 0)                                                         AS approvals_recent
FROM noelle.agent_instances ai
CROSS JOIN LATERAL (SELECT CASE ai.role
    WHEN 'x_intern'        THEN 'x'
    WHEN 'linkedin_intern' THEN 'linkedin'
    WHEN 'reddit_intern'   THEN 'reddit'
  END AS p) plat
CROSS JOIN LATERAL (SELECT
    ((date_trunc('day', now() AT TIME ZONE (ai.run_schedule->>'timezone'))
      + (ai.run_schedule->>'dailyTime')::time)
     AT TIME ZONE (ai.run_schedule->>'timezone')) AS at) slot
WHERE ai.run_schedule IS NOT NULL
  AND (ai.run_schedule->>'enabled') = 'true'
  AND (ai.run_schedule->>'mode') = 'daily'
  AND nullif(ai.run_schedule->>'timezone', '') IS NOT NULL
  AND nullif(ai.run_schedule->>'dailyTime', '') IS NOT NULL
  -- Only the reply interns. A role with no platform mapping (video_intern) must
  -- not silently inherit another intern's lead count.
  AND plat.p IS NOT NULL
ORDER BY ai.display_name;
`;

async function readState() {
  // Pass the SQL with its newlines intact. Flattening it to one line turns each
  // leading `--` into a comment that swallows the REST of the query.
  const out = await psql(STATE_SQL);
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [id, name, role, status, goalActive, drafterOn, goal, dailyTime, slotDueMin,
           ranForThisSlot, leads, approvals] = line.split("|");
    return {
      id, name, role, status,
      goalActive: goalActive === "t",
      drafterOn: drafterOn === "t",
      ranForThisSlot: ranForThisSlot === "t",
      goal: Number(goal),
      dailyTime,
      slotDueMin: Number(slotDueMin),
      leads: Number(leads),
      approvals: Number(approvals),
    };
  });
}

async function refire(id) {
  if (DRY) return "would re-fire";
  // Keyed on the UUID, not on an interpolated display_name — that was both
  // multi-row (two orgs may share a name) and an injection surface.
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`refuse to re-fire on a non-uuid id: ${id}`);
  await psql(
    `UPDATE noelle.agent_instances SET run_schedule_next_at = now() - interval '1 minute',
     updated_at = now() WHERE id = '${id}'`,
  );
  return "re-fired (next_at = now; the scheduler picks it up within its 60s poll)";
}

const findings = [];
const rows = await readState();

if (rows.length === 0) {
  await alert("lead-flow watchdog: NO intern has an enabled daily schedule");
  process.exit(1);
}

for (const r of rows) {
  // Slot still ahead of us today — nothing to judge yet.
  if (r.slotDueMin < GRACE_MIN) {
    const away = r.slotDueMin < 0 ? `${-r.slotDueMin}m away` : `in its ${GRACE_MIN}m grace window`;
    findings.push({ instanceId: r.id, name: r.name, verdict: "ok", detail: `slot ${r.dailyTime} not due yet (${away})` });
    continue;
  }

  const running = r.goalActive || (r.status === "active" && r.drafterOn);

  if (running) {
    findings.push({
      instanceId: r.id, name: r.name,
      verdict: "ok",
      detail: `running (goal=${r.goalActive ? "set" : "none"}, ${r.approvals} approvals/${LEAD_WINDOW_MIN}m)`,
    });
    continue;
  }

  // Not running — but did it already RUN for today's slot and finish?
  //
  // enforceGoal ends a completed run as status='paused', goal_target=null, so a
  // healthy intern that hit its 90 by noon is indistinguishable from one that
  // never started, by "is it running" alone. Without this gate the 13:00 and
  // 19:00 sweeps re-fire every intern that already did its work — 2-3 extra
  // unscheduled goal-runs a day — and page as a supply drought when leads are
  // quiet. It also respects a deliberate operator pause after a completed run.
  if (r.ranForThisSlot) {
    findings.push({
      instanceId: r.id, name: r.name,
      verdict: "ok",
      detail: `already ran for today's ${r.dailyTime} slot and finished (${r.approvals} approvals/${LEAD_WINDOW_MIN}m)`,
    });
    continue;
  }

  // Slot passed and nothing is running. Is there supply to run ON?
  if (r.leads < MIN_LEADS) {
    findings.push({
      instanceId: r.id, name: r.name,
      verdict: "supply",
      detail: `slot ${r.dailyTime} passed ${r.slotDueMin}m ago, not running, and only ${r.leads} leads in ${LEAD_WINDOW_MIN}m — re-firing cannot fix a supply drought`,
    });
    continue;
  }

  const action = await refire(r.id);
  findings.push({
    instanceId: r.id, name: r.name,
    verdict: "fixed",
    detail: `slot ${r.dailyTime} passed ${r.slotDueMin}m ago with no run and ${r.leads} leads waiting — ${action}`,
  });
}

// Verify: re-read, and say whether the re-fire took.
const fixed = findings.filter((f) => f.verdict === "fixed");
if (fixed.length > 0 && !DRY) {
  await new Promise((r) => setTimeout(r, 75_000)); // one scheduler poll + margin
  const after = await readState();
  for (const f of fixed) {
    const row = after.find((a) => a.id === f.instanceId);
    f.verified = row ? row.goalActive || (row.status === "active" && row.drafterOn) : false;
    if (!f.verified) {
      await alert(`lead-flow watchdog: re-fired ${f.name} but it did NOT start — scheduler may be down`);
    }
  }
}

for (const f of findings.filter((x) => x.verdict === "supply")) {
  await alert(`lead-flow watchdog: ${f.name} — ${f.detail}`);
}

if (JSON_OUT) {
  console.log(JSON.stringify({ at: new Date().toISOString(), findings }, null, 2));
} else {
  for (const f of findings) {
    const mark = f.verdict === "ok" ? "ok  " : f.verdict === "fixed" ? (f.verified ? "FIXED" : "FIX?") : "SUPPLY";
    console.log(`${mark.padEnd(6)} ${f.name.padEnd(8)} ${f.detail}`);
  }
}

process.exit(findings.some((f) => f.verdict === "supply" || f.verified === false) ? 1 : 0);

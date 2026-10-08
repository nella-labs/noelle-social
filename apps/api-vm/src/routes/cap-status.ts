import { Hono } from "hono";
import { z } from "zod";
import {
  isOrgMember,
  resolveActiveXInternInstance,
} from "../lib/auth.js";
import { noelleDb } from "../lib/db.js";
import type { AuthContext } from "../middleware/jwt.js";
import { resolveLinkedInVoiceFloor } from "./linkedin-voice-policy.js";

// Per-platform defaults for the HMAC cap report. Current workers enforce their
// own instance-scoped limits. Overridable via env for staging.
const PLATFORM_CAPS: Record<"x" | "linkedin" | "reddit", number> = {
  x: Number(process.env.NOELLE_CAP_X ?? 500),
  linkedin: Number(process.env.NOELLE_CAP_LINKEDIN ?? 100),
  reddit: Number(process.env.NOELLE_CAP_REDDIT ?? 100),
};

const drafterCap = new Hono();

// GET /api/outbound/cap-status — HMAC. The active X instance resolves the org;
// "active" counts pending approval rows whose draft, lead and owning instance
// belong to that org and agree on the native lead platform.
drafterCap.get("/api/outbound/cap-status", async (c) => {
  const owner = await resolveActiveXInternInstance();
  if (!owner) {
    return c.json(
      Object.fromEntries(
        (Object.keys(PLATFORM_CAPS) as Array<keyof typeof PLATFORM_CAPS>).map(
          (k) => [k, { active: 0, cap: PLATFORM_CAPS[k], full: false }]
        )
      )
    );
  }

  const sql = noelleDb();
  const pending = { x: 0, linkedin: 0, reddit: 0 };
  try {
    const rows = await sql<Array<{ platform: keyof typeof pending; count: string }>>`
      select l.platform, count(*)::text as count
      from noelle.approvals a
      join noelle.leads l on l.id = a.lead_id
        and l.org_id = a.org_id and l.agent_instance_id = a.agent_instance_id
      join noelle.drafts d on d.id = a.draft_id
        and d.org_id = a.org_id and d.lead_id = l.id
      join noelle.agent_instances i on i.id = a.agent_instance_id
        and i.org_id = a.org_id and i.role = l.platform || '_intern'
      where a.org_id = ${owner.org_id} and a.status = 'pending'
        and l.platform in ('x', 'linkedin', 'reddit')
      group by l.platform
    `;
    for (const row of rows) pending[row.platform] = Number(row.count);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "cap_status_failed", detail: msg }, 502);
  }

  return c.json(Object.fromEntries(
    (Object.keys(pending) as Array<keyof typeof pending>).map((platform) => [
      platform,
      { active: pending[platform], cap: PLATFORM_CAPS[platform], full: pending[platform] >= PLATFORM_CAPS[platform] },
    ]),
  ));
});

// ---------------------------------------------------------------------------
// GET /api/cap-status?org_id=... — JWT. Dashboard reads layered budget state
// straight from `noelle.org_spend_month`. The bucket_caps table doesn't ship
// in 0.0.1, so `cents_cap` is always null and the dashboard renders that as
// "unlimited" per docs/supabase-contract.md § 5.2.
// ---------------------------------------------------------------------------

const dashboardCap = new Hono<{ Variables: { auth: AuthContext } }>();

// Expose the exact server-side LinkedIn voice threshold to the JWT dashboard.
// This is presentation state only; the actuator still enforces it on claim.
dashboardCap.get("/api/linkedin-review-policy", async (c) => {
  c.header("cache-control", "no-store");
  const orgId = c.req.query("org_id");
  if (!orgId) return c.json({ error: "missing_org_id" }, 400);
  if (!z.string().uuid().safeParse(orgId).success) {
    return c.json({ error: "invalid_org_id" }, 400);
  }
  if (!(await isOrgMember(c.get("auth").userId, orgId))) {
    return c.json({ error: "not_org_member" }, 403);
  }
  return c.json({ org_id: orgId, voice_floor: resolveLinkedInVoiceFloor() });
});

dashboardCap.get("/api/cap-status", async (c) => {
  const auth = c.get("auth");
  const orgId = c.req.query("org_id");
  if (!orgId) {
    return c.json({ error: "missing_org_id" }, 400);
  }
  if (!(await isOrgMember(auth.userId, orgId))) {
    return c.json({ error: "not_org_member" }, 403);
  }

  const now = new Date();
  const monthDate = `${now.getUTCFullYear()}-${String(
    now.getUTCMonth() + 1
  ).padStart(2, "0")}-01`;
  const monthLabel = monthDate.slice(0, 7);

  const sql = noelleDb();
  let spendRows: Array<{ bucket: string; cents: string | number | null }>;
  try {
    spendRows = (await sql<
      Array<{ bucket: string; cents: string | number | null }>
    >`
      select bucket, cents
      from noelle.org_spend_month
      where org_id = ${orgId} and month = ${monthDate}
    `) as Array<{ bucket: string; cents: string | number | null }>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "spend_read_failed", detail: msg }, 502);
  }

  const spend = spendRows.map((r) => ({
    bucket: r.bucket as
      | "drafter-codex"
      | "drafter-bedrock"
      | "drafter-vertex"
      | "classifier"
      | "quality-gate"
      | "other",
    cents_spent: Number(r.cents ?? 0),
    cents_cap: null as number | null,
    layer: "bucket" as const,
  }));

  return c.json({
    org_id: orgId,
    month: monthLabel,
    spend,
    any_over: false,
  });
});

export { drafterCap, dashboardCap };

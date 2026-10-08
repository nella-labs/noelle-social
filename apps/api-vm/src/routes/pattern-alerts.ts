import { Hono, type Context } from "hono";
import {
  PatternRefineInputSchema,
  PatternAlertsPageInputSchema,
  decodePatternCursor,
  UuidSchema,
} from "@noelle/contracts";
import {
  getPatternAlertScope,
  getPatternInstanceScope,
  loadVisibleAlerts,
  mutatePatternAlert,
  patternAlertView,
  type PatternScope,
} from "@noelle/runtime/pattern-breaker-db";
import { isOrgMember } from "../lib/auth.js";
import { noelleDb } from "../lib/db.js";
import type { AuthContext } from "../middleware/jwt.js";

const patternAlerts = new Hono<{ Variables: { auth: AuthContext } }>();
type AlertCtx = Context<{ Variables: { auth: AuthContext } }>;

patternAlerts.get("/api/pattern-alerts", async (c) => {
  const instanceId = c.req.query("instanceId");
  if (!instanceId || !UuidSchema.safeParse(instanceId).success)
    return c.json({ error: "invalid_instance_id" }, 400);
  const cursorText = c.req.query("cursor");
  let cursor: unknown;
  try {
    cursor = decodePatternCursor(cursorText);
  } catch {
    return c.json({ error: "invalid_page" }, 400);
  }
  const limitText = c.req.query("limit");
  const parsed = PatternAlertsPageInputSchema.safeParse({
    ...(cursor === undefined ? {} : { cursor }),
    ...(limitText === undefined
      ? {}
      : { limit: /^\d{1,3}$/.test(limitText) ? Number(limitText) : NaN }),
    ...(c.req.query("view") === undefined ? {} : { view: c.req.query("view") }),
  });
  if (!parsed.success) return c.json({ error: "invalid_page" }, 400);
  const sql = noelleDb();
  const current = await getPatternInstanceScope(sql, instanceId);
  if (!current) return c.json({ error: "not_found" }, 404);
  const userId = c.get("auth").userId;
  if (!(await isOrgMember(userId, current.orgId))) return c.json({ error: "not_org_member" }, 403);
  const scope = { ...current, userId };
  const page = await loadVisibleAlerts(sql, scope, parsed.data);
  return c.json(
    { alerts: page.alerts.map(patternAlertView), nextCursor: page.nextCursor, total: page.total },
    200,
  );
});

async function authorizedScope(
  c: AlertCtx,
): Promise<{ scope: PatternScope } | { error: Response }> {
  const id = c.req.param("id");
  if (!id || !UuidSchema.safeParse(id).success)
    return { error: c.json({ error: "invalid_id" }, 400) };
  const scope = await getPatternAlertScope(noelleDb(), id);
  if (!scope) return { error: c.json({ error: "not_found" }, 404) };
  const userId = c.get("auth").userId;
  if (!(await isOrgMember(userId, scope.orgId)))
    return { error: c.json({ error: "not_org_member" }, 403) };
  return { scope: { ...scope, userId } };
}
async function decide(c: AlertCtx, action: "revert" | "acknowledge" | "refine") {
  const auth = await authorizedScope(c);
  if ("error" in auth) return auth.error;
  let input: { note?: string; expectedRequestId?: string } = {};
  if (action === "refine") {
    const parsed = PatternRefineInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    input = parsed.data;
  }
  const result = await mutatePatternAlert(noelleDb(), auth.scope, {
    alertId: c.req.param("id")!,
    action,
    ...input,
    decidedBy: c.get("auth").userId,
  });
  if (!result) return c.json({ error: "stale_or_unavailable" }, 409);
  return c.json(
    { id: c.req.param("id"), status: result.status, refineRequestId: result.requestId },
    200,
  );
}
patternAlerts.post("/api/pattern-alerts/:id/revert", (c) => decide(c, "revert"));
patternAlerts.post("/api/pattern-alerts/:id/refine", (c) => decide(c, "refine"));
patternAlerts.post("/api/pattern-alerts/:id/acknowledge", (c) => decide(c, "acknowledge"));
export { patternAlerts };

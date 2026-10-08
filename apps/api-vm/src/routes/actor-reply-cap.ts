import { Hono } from "hono";
import { z } from "zod";
import { ActorReplyCapWriteSchema, type ActorReplyCapState } from "@noelle/contracts";
import { noelleDb } from "../lib/db.js";
import { requireActuatorToken, type ActuatorContext } from "../middleware/actuator.js";
import { readXBrowserReplyUsage } from "../lib/x-browser-reply-usage-db.js";
import { readXBrowserReplyCap, writeXBrowserReplyCap } from "../lib/x-browser-reply-cap-db.js";

import { resolveBrowserReplyCap, type BrowserPlatform } from "../lib/browser-reply-cap.js";
export { resolveBrowserReplyCap, resolveDailyWriteCap, resolveXDailyWriteCap } from "../lib/browser-reply-cap.js";

export const actorReplyCap = new Hono<{ Variables: { actuator: ActuatorContext } }>();
actorReplyCap.use("/api/actuator/reply-cap", requireActuatorToken);

const requestSchema = z.object({ platform: z.enum(["linkedin", "x"]), instanceId: z.string().uuid() });
async function state(orgId: string, platform: BrowserPlatform,
  policy: Pick<ActorReplyCapState, "cap" | "configuredCap" | "minimum" | "day">) {
  const sql = noelleDb();
  const rows = platform === "linkedin"
    ? await sql<Array<{ sent: number }>>`
      select count(*)::int as sent from noelle.linkedin_activity
      where org_id = ${orgId} and type = 'comment' and created_at >= date_trunc('day', now())
    `
    : await sql<Array<{ sent: number }>>`
      select count(*)::int as sent from noelle.x_activity
      where org_id = ${orgId} and type = 'reply' and created_at >= date_trunc('day', now())
    `;
  const sent = rows[0]?.sent ?? 0;
  const { cap } = policy;
  const used = platform === "x" && cap !== null ? await readXBrowserReplyUsage(sql, orgId) : sent;
  return { sent, ...policy, remaining: cap === null ? null : Math.max(0, cap - used) };
}

actorReplyCap.get("/api/actuator/reply-cap", async (c) => {
  const parsed = requestSchema.safeParse({ platform: c.req.query("platform"), instanceId: c.req.query("instanceId") });
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const { platform, instanceId } = parsed.data;
  const { orgId } = c.get("actuator");
  if (platform === "x") {
    const policy = await readXBrowserReplyCap(noelleDb(), { orgId, instanceId });
    if (!policy) return c.json({ error: "instance_not_in_org" }, 403);
    return c.json(await state(orgId, platform, policy));
  }
  const rows = await noelleDb()<Array<{ actuator_daily_reply_cap: number | null }>>`
    select actuator_daily_reply_cap from noelle.agent_instances
    where id = ${instanceId} and org_id = ${orgId}
      and role = ${platform === "linkedin" ? "linkedin_intern" : "x_intern"} limit 1
  `;
  if (!rows[0]) return c.json({ error: "instance_not_in_org" }, 403);
  return c.json(await state(orgId, platform, { cap: resolveBrowserReplyCap(platform, rows[0].actuator_daily_reply_cap) }));
});

actorReplyCap.post("/api/actuator/reply-cap", async (c) => {
  const parsed = requestSchema.safeParse({ platform: c.req.query("platform"), instanceId: c.req.query("instanceId") });
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const body = ActorReplyCapWriteSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_cap" }, 400);
  const { platform, instanceId } = parsed.data;
  const { orgId } = c.get("actuator");
  if (platform === "x") {
    const policy = await writeXBrowserReplyCap(noelleDb(), { orgId, instanceId }, body.data);
    if (!policy) return c.json({ error: "instance_not_in_org" }, 403);
    return c.json(await state(orgId, platform, policy));
  }
  if (body.data.minimum != null) return c.json({ error: "invalid_cap" }, 400);
  const rows = await noelleDb()<Array<{ actuator_daily_reply_cap: number | null }>>`
    update noelle.agent_instances set actuator_daily_reply_cap = ${body.data.cap}, updated_at = now()
    where id = ${instanceId} and org_id = ${orgId}
      and role = ${platform === "linkedin" ? "linkedin_intern" : "x_intern"}
    returning actuator_daily_reply_cap
  `;
  if (!rows[0]) return c.json({ error: "instance_not_in_org" }, 403);
  return c.json(await state(orgId, platform, { cap: resolveBrowserReplyCap(platform, rows[0].actuator_daily_reply_cap) }));
});

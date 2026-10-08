import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";
import { loadEnv } from "../env.js";

export type ActuatorContext = { orgId: string };

export const requireActuatorToken: MiddlewareHandler<{
  Variables: { actuator: ActuatorContext };
}> = async (c, next) => {
  const env = loadEnv();
  if (!env.NOELLE_ACTUATOR_TOKEN || !env.NOELLE_ACTUATOR_ORG_ID) {
    return c.json({ error: "actuator_not_configured" }, 503);
  }
  const header = c.req.header("authorization") ?? c.req.header("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return c.json({ error: "missing_bearer_token" }, 401);
  }
  const token = header.slice("bearer ".length).trim();
  const a = Buffer.from(token);
  const b = Buffer.from(env.NOELLE_ACTUATOR_TOKEN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.json({ error: "invalid_token" }, 401);
  }
  c.set("actuator", { orgId: env.NOELLE_ACTUATOR_ORG_ID });
  await next();
};

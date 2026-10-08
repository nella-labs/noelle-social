import { expect, test } from "vitest";
import { AgentRoleSchema, SOCIAL_AGENT_ROLES, isSocialAgentRole } from "./common.js";

test("social roles share one closed contract", () => {
  expect(SOCIAL_AGENT_ROLES).toEqual(["x_intern", "linkedin_intern", "reddit_intern", "video_intern"]);
  for (const role of SOCIAL_AGENT_ROLES) {
    expect(AgentRoleSchema.parse(role)).toBe(role);
    expect(isSocialAgentRole(role)).toBe(true);
  }
});

test.each(["ceo", "cmo", "researcher", ""])("rejects non-social role %s", (role) => {
  expect(AgentRoleSchema.safeParse(role).success).toBe(false);
  expect(isSocialAgentRole(role)).toBe(false);
});

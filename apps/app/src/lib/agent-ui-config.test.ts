import { SOCIAL_AGENT_ROLES } from "@noelle/contracts";
import { SOCIAL_CHANNELS } from "./social-channels";
import { INTERN_ROLES } from "./guided/types";
import { describe, expect, it } from "vitest";
import { AGENT_UI, agentUiFor, isInternRole } from "./agent-ui-config";

describe("agent-ui-config", () => {
  it("every supported role has channel identity, setup and capability owners", () => {
    expect(INTERN_ROLES).toEqual([...SOCIAL_AGENT_ROLES]);
    expect(SOCIAL_CHANNELS.map(channel => channel.role)).toEqual([...SOCIAL_AGENT_ROLES]);
    for (const role of SOCIAL_AGENT_ROLES) {
      expect(isInternRole(role)).toBe(true);
      expect(agentUiFor(role)).toBe(AGENT_UI[role]);
    }
    expect(isInternRole("ceo")).toBe(false);
    expect(isInternRole(null)).toBe(false);
    expect(isInternRole(undefined)).toBe(false);
  });

  it("agentUiFor resolves intern roles and null otherwise", () => {
    expect(agentUiFor("x_intern")).toBe(AGENT_UI.x_intern);
    expect(agentUiFor("linkedin_intern")).toBe(AGENT_UI.linkedin_intern);
    expect(agentUiFor("cmo")).toBeNull();
  });

  it("X exposes the search-operator tailored run + send queue", () => {
    const x = AGENT_UI.x_intern;
    expect(x.supportsSendQueue).toBe(true);
    const keys = x.pipeline.tailorFields.map((f) => f.key);
    expect(keys).toEqual(["timeWindowHours", "postsPerSource", "minFaves", "minReplies"]);
    expect(x.pipeline.tailorBooleans.map((b) => b.key)).toEqual([
      "excludeRetweets",
      "excludeReplies",
    ]);
    expect(x.pipeline.tailorLang).toBe(true);
    // postsPerSource is the one field that can't be cleared to null.
    expect(x.pipeline.tailorFields.find((f) => f.key === "postsPerSource")?.nullable).toBe(false);
  });

  it("LinkedIn exposes the engagement tailored run, no send queue, no X-only fields", () => {
    const li = AGENT_UI.linkedin_intern;
    expect(li.supportsSendQueue).toBe(false);
    const keys = li.pipeline.tailorFields.map((f) => f.key);
    expect(keys).toEqual(["timeWindowHours", "postsPerSource", "minReactions", "minComments"]);
    expect(keys).not.toContain("minFaves");
    expect(li.pipeline.tailorBooleans).toEqual([]);
    expect(li.pipeline.tailorLang).toBe(false);
    // Copy reflects draft-only.
    expect(li.pipeline.goalNoun).not.toBe(AGENT_UI.x_intern.pipeline.goalNoun);
    expect(li.pipeline.drafterRole.toLowerCase()).toContain("never sends");
  });

  it("both interns support per-person watchlist objectives + manual add", () => {
    for (const role of ["x_intern", "linkedin_intern"] as const) {
      expect(AGENT_UI[role].watchlist.objectives).toBe(true);
      expect(AGENT_UI[role].watchlist.add).not.toBeNull();
    }
  });
});

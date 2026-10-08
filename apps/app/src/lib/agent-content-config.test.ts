import { describe, expect, it } from "vitest";
import {
  AGENT_CONTENT_CONFIGS,
  ALL_AGGREGATE,
  configForPlatform,
  configForRole,
  LANE_VIEWS,
  platformToRole,
  roleToPlatform,
  type ContentAgentRole,
  type ContentPlatform,
} from "./agent-content-config";
import { CONTENT_LANES } from "@/components/posts/content-lanes";
import { AGENT_UI } from "./agent-ui-config";

const INTERN_ROLES: ContentAgentRole[] = [
  "x_intern",
  "linkedin_intern",
  "reddit_intern",
  "video_intern",
];

describe("agent-content-config", () => {
  it("derives CONTENT_LANES byte-for-byte with the pre-refactor literal (behaviour-neutral)", () => {
    expect(CONTENT_LANES).toEqual([
      { id: "all", label: "All", agent: "—", role: null, color: "var(--ink)" },
      { id: "linkedin", label: "LinkedIn", agent: "Lyra", role: "linkedin-intern", color: "var(--info)", sub: "posts · comments" },
      { id: "x", label: "X", agent: "Vega", role: "x-intern", color: "var(--accent)", sub: "replies · threads" },
      { id: "reddit", label: "Reddit", agent: "Orion", role: "reddit-intern", color: "var(--ok)", sub: "replies" },
      { id: "video", label: "Video", agent: "Nova", role: "video-intern", color: "oklch(0.58 0.13 305)", sub: "IG · TikTok", isNew: true },
    ]);
  });

  it("only Vega (x_intern) can auto-post; everyone else is draft-only", () => {
    expect(AGENT_CONTENT_CONFIGS.x_intern.capabilities.canAutoPost).toBe(true);
    expect(AGENT_CONTENT_CONFIGS.linkedin_intern.capabilities.canAutoPost).toBe(false);
    expect(AGENT_CONTENT_CONFIGS.reddit_intern.capabilities.canAutoPost).toBe(false);
    expect(AGENT_CONTENT_CONFIGS.video_intern.capabilities.canAutoPost).toBe(false);
  });

  it("draftOnly is the strict inverse of canAutoPost, and matches scheduling.canPost", () => {
    for (const role of INTERN_ROLES) {
      const c = AGENT_CONTENT_CONFIGS[role];
      expect(c.draftOnly).toBe(!c.capabilities.canAutoPost);
      expect(c.scheduling.canPost).toBe(c.capabilities.canAutoPost);
    }
  });

  it("stays consistent with agent-ui-config's send-queue capability (drift guard)", () => {
    for (const role of INTERN_ROLES) {
      expect(AGENT_CONTENT_CONFIGS[role].draftOnly).toBe(!AGENT_UI[role].supportsSendQueue);
    }
  });

  it("Vega's combined daily X cap is 30", () => {
    expect(AGENT_CONTENT_CONFIGS.x_intern.scheduling.maxPerDay).toBe(30);
  });

  it("agent lanes carry the Schedule section; the aggregate does not", () => {
    for (const role of INTERN_ROLES) {
      expect(AGENT_CONTENT_CONFIGS[role].sections).toContain("schedule");
    }
    expect(ALL_AGGREGATE.sections).not.toContain("schedule");
  });

  it("the All aggregate never gains auto-post-only sections", () => {
    for (const section of ["compose", "schedule", "inbox", "trending", "performance", "voice"] as const) {
      expect(ALL_AGGREGATE.sections).not.toContain(section);
    }
    expect(ALL_AGGREGATE.sections).toEqual(["overview", "ideas", "drafts", "media"]);
    expect(ALL_AGGREGATE.role).toBeNull();
  });

  it("round-trips platform <-> role for every intern lane", () => {
    for (const role of INTERN_ROLES) {
      const platform = roleToPlatform(role);
      expect(platformToRole(platform)).toBe(role);
      expect(configForRole(role).platform).toBe(platform);
    }
    expect(platformToRole("all")).toBeNull();
  });

  it("resolves the aggregate for ?platform=all and the right agent otherwise", () => {
    expect(configForPlatform("all")).toBe(ALL_AGGREGATE);
    expect(configForPlatform("x").role).toBe("x_intern");
    expect(configForPlatform("video").role).toBe("video_intern");
  });

  it("exposes exactly the five lanes in switcher order", () => {
    expect(LANE_VIEWS.map((v) => v.platform)).toEqual<ContentPlatform[]>([
      "all",
      "linkedin",
      "x",
      "reddit",
      "video",
    ]);
  });
});

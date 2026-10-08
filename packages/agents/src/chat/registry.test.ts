import { describe, expect, it } from "vitest";
import { getChatProfile, tryGetChatProfile } from "./index.js";
import { SOCIAL_AGENT_ROLES } from "../types.js";

describe("social chat profile registry", () => {
  it.each(SOCIAL_AGENT_ROLES)("resolves the %s profile", (role) => {
    expect(getChatProfile(role).role).toBe(role);
    expect(tryGetChatProfile(role)).toBe(getChatProfile(role));
  });

  it.each(SOCIAL_AGENT_ROLES)("keeps %s grounded in the configured workspace", (role) => {
    const prompt = getChatProfile(role).systemPrompt({ displayName: "Example profile", context: { objective: "Teach useful skills" } });
    expect(prompt).toContain("Example profile");
    expect(prompt).toContain("Teach useful skills");
    expect(prompt).toContain("workspace voice context");
    expect(prompt).not.toMatch(/Pablo|org-chart|Head of Growth|Chief of Staff/);
  });

  it.each(["ceo", "cmo", "unknown_role", ""])("rejects unsupported role %s", (role) => {
    expect(tryGetChatProfile(role)).toBeNull();
  });
});

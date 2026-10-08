import { describe, expect, test } from "vitest";
import { AGENT_UUID_RE, agentSlug, agentHref, matchAgentBySlug } from "./agent-route";

const UUID = "bd267e43-3859-4c33-aac5-a9fe5fa29da5";

describe("agentSlug", () => {
  test("slugifies a display name", () => {
    expect(agentSlug("Vega", UUID)).toBe("vega");
    expect(agentSlug("Head of Growth", UUID)).toBe("head-of-growth");
    expect(agentSlug("  Cosmo!! ", UUID)).toBe("cosmo");
  });

  test("falls back to the id when the name is empty/blank", () => {
    expect(agentSlug("", UUID)).toBe(UUID);
    expect(agentSlug(null, UUID)).toBe(UUID);
    expect(agentSlug("   ", UUID)).toBe(UUID);
    expect(agentSlug("✦✦", UUID)).toBe(UUID);
  });
});

describe("AGENT_UUID_RE", () => {
  test("matches a UUID, rejects a slug", () => {
    expect(AGENT_UUID_RE.test(UUID)).toBe(true);
    expect(AGENT_UUID_RE.test("vega")).toBe(false);
    expect(AGENT_UUID_RE.test("x-intern")).toBe(false);
  });
});

describe("agentHref", () => {
  test("uses the slug and prefers instanceId over id", () => {
    expect(agentHref("operator", { name: "Vega", id: "roster", instanceId: UUID })).toBe(
      "/app/operator/agents/vega",
    );
    expect(agentHref("operator", { display_name: "Vega", id: UUID }, "config")).toBe(
      "/app/operator/agents/vega/config",
    );
  });
});

describe("matchAgentBySlug", () => {
  const vega = { display_name: "Vega", id: UUID };
  const cosmo = { display_name: "Cosmo", id: "11111111-1111-1111-1111-111111111111" };

  test("resolves a unique slug", () => {
    expect(matchAgentBySlug([vega, cosmo], "vega")).toBe(vega);
    expect(matchAgentBySlug([vega, cosmo], "cosmo")).toBe(cosmo);
  });

  test("returns null on no match", () => {
    expect(matchAgentBySlug([vega, cosmo], "marlow")).toBeNull();
  });

  test("returns null when ambiguous", () => {
    const dupe = { display_name: "Vega", id: "22222222-2222-2222-2222-222222222222" };
    expect(matchAgentBySlug([vega, dupe], "vega")).toBeNull();
  });

  test("matches by UUID fallback when name is blank", () => {
    const nameless = { display_name: null, id: UUID };
    expect(matchAgentBySlug([nameless], UUID)).toBe(nameless);
  });
});

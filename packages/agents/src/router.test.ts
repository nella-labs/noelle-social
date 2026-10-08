import { describe, expect, it, vi } from "vitest";
import type { AgentCapability, AgentManifest, AgentRole } from "./types.js";
import {
  routeByCapability,
  routeByIntent,
  type RouterModelCall,
} from "./router.js";

/** Minimal valid manifest; attach an optional capability facet. */
function mk(id: AgentRole, capability?: AgentCapability): AgentManifest {
  return {
    id,
    display_name: id,
    short_description: "",
    icon: "dot",
    default_model: { primary: { engine: "bedrock", model: "claude-sonnet-4-6" } },
    default_bucket: "b",
    default_budget_cap_cents: 1000,
    tools: [],
    hireable: true,
    ...(capability ? { capability } : {}),
  };
}

describe("routeByCapability (pure deterministic tier)", () => {
  it("matches the single declared handler and returns via:capability, no alternatives", () => {
    const manifests = [
      mk("video_intern"), // no capability facet — ignored
      mk("x_intern", { handles: ["engagement.reply.x"], surfaces: ["agent_chat"] }),
    ];
    const decision = routeByCapability(
      { capability: "engagement.reply.x", surface: "agent_chat" },
      manifests,
    );
    expect(decision).toEqual({
      kind: "match",
      role: "x_intern",
      via: "capability",
      alternatives: [],
    });
  });

  it("filters by surface: a handler on another surface does not match", () => {
    const manifests = [
      mk("x_intern", { handles: ["engagement.reply.x"], surfaces: ["agent_chat"] }),
    ];
    const decision = routeByCapability(
      { capability: "engagement.reply.x", surface: "content" },
      manifests,
    );
    expect(decision.kind).toBe("none");
  });

  it("returns {kind:none} when no role handles the tag (never guesses)", () => {
    const manifests = [
      mk("x_intern", { handles: ["engagement.reply.x"], surfaces: ["agent_chat"] }),
    ];
    const decision = routeByCapability(
      { capability: "content.post.draft", surface: "agent_chat" },
      manifests,
    );
    expect(decision).toEqual({
      kind: "none",
      reason: `no role handles "content.post.draft" on surface "agent_chat"`,
    });
  });

  it("returns {kind:none} for an empty manifest set", () => {
    expect(
      routeByCapability({ capability: "engagement.reply.x", surface: "agent_chat" }, []).kind,
    ).toBe("none");
  });

  it("tie-breaks priority desc, then id asc, and orders alternatives the same way", () => {
    const tag = "engagement.reply.x" as const;
    const s = "agent_chat" as const;
    // Same (tag, surface); the router is deterministic even when priorities tie
    // (the loader's ambiguity guard forbids ties in real registries).
    const manifests = [
      mk("linkedin_intern", { handles: [tag], surfaces: [s], priority: 1 }),
      mk("reddit_intern", { handles: [tag], surfaces: [s], priority: 5 }),
      mk("x_intern", { handles: [tag], surfaces: [s], priority: 5 }),
      mk("video_intern", { handles: [tag], surfaces: [s], priority: 9 }),
    ];
    const decision = routeByCapability({ capability: tag, surface: s }, manifests);
    // priority 9 wins despite 'v' sorting last; equal-priority 5s break by id asc.
    expect(decision).toEqual({
      kind: "match",
      role: "video_intern",
      via: "capability",
      alternatives: ["reddit_intern", "x_intern", "linkedin_intern"],
    });
  });

  it("treats a missing priority as 0 for tie-break", () => {
    const tag = "engagement.reply.x" as const;
    const s = "agent_chat" as const;
    const manifests = [
      mk("x_intern", { handles: [tag], surfaces: [s] }), // priority undefined → 0
      mk("reddit_intern", { handles: [tag], surfaces: [s], priority: 3 }),
    ];
    const decision = routeByCapability({ capability: tag, surface: s }, manifests);
    expect(decision).toMatchObject({ role: "reddit_intern", alternatives: ["x_intern"] });
  });

  it("accepts a registry-style ReadonlyMap as well as an array", () => {
    const map = new Map<AgentRole, AgentManifest>([
      ["x_intern", mk("x_intern", { handles: ["engagement.reply.x"], surfaces: ["agent_chat"] })],
    ]);
    const decision = routeByCapability(
      { capability: "engagement.reply.x", surface: "agent_chat" },
      map,
    );
    expect(decision).toMatchObject({ kind: "match", role: "x_intern" });
  });
});

describe("routeByIntent (LLM disambiguation tier)", () => {
  const manifests = [
    mk("x_intern", { handles: ["engagement.reply.x"], surfaces: ["agent_chat"] }),
    mk("video_intern", {
      handles: ["content.video.script"],
      surfaces: ["agent_chat", "content"],
      intent_examples: ["write me a video script"],
    }),
  ];

  it("fast path: a concrete capability short-circuits the model entirely", async () => {
    const call = vi.fn<RouterModelCall>(async () => ({ text: "{}" }));
    const decision = await routeByIntent(
      { capability: "engagement.reply.x", surface: "agent_chat" },
      manifests,
      { call },
    );
    expect(call).not.toHaveBeenCalled();
    expect(decision).toMatchObject({ kind: "match", role: "x_intern", via: "capability" });
  });

  it("happy path: classifies free text to a declared capability, tagged via:llm", async () => {
    const call: RouterModelCall = async () => ({
      text: JSON.stringify({ capability: "engagement.reply.x" }),
    });
    const decision = await routeByIntent(
      { surface: "agent_chat", text: "draft a reply to this tweet" },
      manifests,
      { call },
    );
    expect(decision).toEqual({
      kind: "match",
      role: "x_intern",
      via: "llm",
      alternatives: [],
    });
  });

  it("fail-closed: malformed JSON yields {kind:none}, never a role", async () => {
    const call: RouterModelCall = async () => ({ text: "sorry, I can't help with that" });
    const decision = await routeByIntent(
      { surface: "agent_chat", text: "draft a reply to this tweet" },
      manifests,
      { call },
    );
    expect(decision.kind).toBe("none");
  });

  it("fail-closed: a model error yields {kind:none}", async () => {
    const call: RouterModelCall = async () => {
      throw new Error("bedrock timeout");
    };
    const decision = await routeByIntent(
      { surface: "agent_chat", text: "draft a reply to this tweet" },
      manifests,
      { call },
    );
    expect(decision.kind).toBe("none");
  });

  it("NEVER returns a non-handler role: rejects hallucinated tags AND role names", async () => {
    // Each of these model outputs must resolve to {kind:none}: an unoffered but
    // real vocabulary tag, a fabricated tag, and a raw role name.
    const badOutputs = [
      JSON.stringify({ capability: "engagement.reply.reddit" }), // real tag, no handler in fixture
      JSON.stringify({ capability: "totally.made.up" }), // not in vocabulary
      JSON.stringify({ capability: "x_intern" }), // a ROLE, not a tag
      JSON.stringify({ capability: "" }),
    ];
    for (const text of badOutputs) {
      const call: RouterModelCall = async () => ({ text });
      const decision = await routeByIntent(
        { surface: "agent_chat", text: "do something vague" },
        manifests,
        { call },
      );
      expect(decision.kind).toBe("none");
    }
  });

  it("returns {kind:none} on empty text without calling the model", async () => {
    const call = vi.fn<RouterModelCall>(async () => ({ text: "{}" }));
    const decision = await routeByIntent({ surface: "agent_chat", text: "  " }, manifests, {
      call,
    });
    expect(call).not.toHaveBeenCalled();
    expect(decision.kind).toBe("none");
  });

  it("returns {kind:none} when no capability is routable on the surface", async () => {
    const call = vi.fn<RouterModelCall>(async () => ({ text: "{}" }));
    // Nothing declares the `bus` surface in the fixture.
    const decision = await routeByIntent(
      { surface: "bus", text: "draft a reply to this tweet" },
      manifests,
      { call },
    );
    expect(call).not.toHaveBeenCalled();
    expect(decision.kind).toBe("none");
  });
});

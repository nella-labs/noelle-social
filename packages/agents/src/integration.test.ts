import { describe, expect, it, vi } from "vitest";
import { loadRegistryFromDisk } from "./loader.js";
import { createXInternAgent } from "./types/x_intern.js";
import { createLinkedinInternAgent } from "./types/linkedin_intern.js";
import { createRedditInternAgent } from "./types/reddit_intern.js";
import { createVideoInternAgent } from "./types/video_intern.js";
import type { RuntimeServices } from "./services.js";
import type { Hit } from "@noelle/runtime/nella";
import type { CallAgentModelResult } from "@noelle/runtime/call";

function stubServices(overrides: Partial<RuntimeServices> = {}): RuntimeServices {
  return {
    callAgentModel: vi.fn(
      async (): Promise<CallAgentModelResult> => ({
        text: "ok",
        usage: { input_tokens: 1, output_tokens: 1 },
        engineUsed: { engine: "bedrock", model: "claude-sonnet-4-6" },
        outcome: "ok",
      }),
    ),
    nella: {
      searchContext: vi.fn(async () => [] as Hit[]),
      getAnchors: vi.fn(async () => []),
      ready: vi.fn(async () => true),
    },
    ...overrides,
  };
}

describe("agent registry end-to-end", () => {
  it("loads YAML manifests + real agent classes into a working registry", () => {
    const svc = stubServices();
    const registry = loadRegistryFromDisk({
      agentClasses: [
        createXInternAgent(svc),
        createLinkedinInternAgent(svc),
        createRedditInternAgent(svc),
        createVideoInternAgent(svc),
      ],
    });
    expect(registry.get("x_intern").id).toBe("x_intern");
    expect(registry.get("linkedin_intern").id).toBe("linkedin_intern");
    expect(registry.get("reddit_intern").id).toBe("reddit_intern");
    expect(registry.get("video_intern").id).toBe("video_intern");
    expect(registry.getManifest("x_intern").default_budget_cap_cents).toBe(10000);
  });

  it("x_intern escalation predicate fires for hot leads", () => {
    const svc = stubServices();
    const xi = createXInternAgent(svc);
    const ctx = {
      orgId: "o", instanceId: "i", bucket: "drafter",
      routing: xi.defaultModel, log: () => {},
      payload: { velocity_score: 99 },
    };
    expect(xi.defaultModel.escalation?.when(ctx)).toBe(true);
  });

  it("x_intern escalation predicate stays cold for low velocity", () => {
    const svc = stubServices();
    const xi = createXInternAgent(svc);
    const ctx = {
      orgId: "o", instanceId: "i", bucket: "drafter",
      routing: xi.defaultModel, log: () => {},
      payload: { velocity_score: 30 },
    };
    expect(xi.defaultModel.escalation?.when(ctx)).toBe(false);
  });

  it("x_intern.run() pulls anchors via vault resolver and calls the model", async () => {
    const vault = {
      getAnchors: vi.fn(async () => [] as Hit[]),
      resolve: vi.fn(async () => ({ nella_workspace_id: "mars-acme", status: "active" })),
      __resetCache: vi.fn(),
    };
    const svc = stubServices({ vault });
    const xi = createXInternAgent(svc);
    await xi.run!({
      orgId: "org-acme", instanceId: "i", bucket: "drafter",
      routing: xi.defaultModel, log: () => {},
      payload: { id: "lead_1", post_text: "shipping daily", handle: "example", velocity_score: 30 },
    });
    expect(vault.getAnchors).toHaveBeenCalledWith({
      orgId: "org-acme",
      query: "shipping daily",
    });
    expect(svc.nella.searchContext).not.toHaveBeenCalled();
    expect(svc.callAgentModel).toHaveBeenCalledOnce();
  });

  it("x_intern.run() uses no private workspace when vault is absent", async () => {
    const svc = stubServices(); // no vault
    const xi = createXInternAgent(svc);
    await xi.run!({
      orgId: "o", instanceId: "i", bucket: "drafter",
      routing: xi.defaultModel, log: () => {},
      payload: { id: "lead_1", post_text: "shipping daily", handle: "example", velocity_score: 30 },
    });
    expect(svc.nella.searchContext).not.toHaveBeenCalled();
    expect(svc.callAgentModel).toHaveBeenCalledOnce();
  });

});

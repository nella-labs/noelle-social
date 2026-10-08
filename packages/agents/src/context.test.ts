import { expect, it, vi } from "vitest";
import type { CallAgentModelResult } from "@noelle/runtime/call";
import type { RuntimeServices } from "./services.js";
import { createXInternAgent } from "./types/x_intern.js";
import { createLinkedinInternAgent } from "./types/linkedin_intern.js";
import { createRedditInternAgent } from "./types/reddit_intern.js";
import { createVideoInternAgent } from "./types/video_intern.js";

const factories = [createXInternAgent, createLinkedinInternAgent, createRedditInternAgent, createVideoInternAgent];
function services(): RuntimeServices {
  return {
    callAgentModel: vi.fn(async (): Promise<CallAgentModelResult> => ({ text: "draft", usage: { input_tokens: 1, output_tokens: 1 }, engineUsed: { engine: "bedrock", model: "claude-sonnet-4-6" }, outcome: "ok" })),
    nella: { searchContext: vi.fn(async () => []), getAnchors: vi.fn(async () => []), ready: vi.fn(async () => true) },
  };
}

it.each(factories)("requires an explicit workspace for every social search tool", async (createAgent) => {
  const svc = services();
  const agent = createAgent(svc);
  const search = agent.tools.find((tool) => tool.id === "nella.search")!;
  const ctx = { orgId: "workspace-org", instanceId: "profile", bucket: "drafter", routing: agent.defaultModel, payload: {}, log: () => {} };
  for (const workspace of [undefined, ""]) {
    await expect(search.handler({ q: "voice", workspace }, ctx)).rejects.toThrow();
  }
  expect(svc.nella.searchContext).not.toHaveBeenCalled();
  await search.handler({ q: "voice", workspace: "configured-workspace" }, ctx);
  expect(svc.nella.searchContext).toHaveBeenCalledWith({ query: "voice", workspace: "configured-workspace" });
});

it.each(factories)("drafts without borrowing context when no vault is configured", async (createAgent) => {
  const svc = services();
  const agent = createAgent(svc);
  await agent.run!({ orgId: "workspace-org", instanceId: "profile", bucket: "drafter", routing: agent.defaultModel, payload: { id: "idea", post_text: "A useful topic", hook: "A useful topic" }, log: () => {} });
  expect(svc.nella.searchContext).not.toHaveBeenCalled();
  expect(svc.nella.getAnchors).not.toHaveBeenCalled();
  expect(svc.callAgentModel).toHaveBeenCalledWith(expect.objectContaining({ orgId: "workspace-org", agentRole: agent.id }));
});

it.each(factories)("uses only the drafting organization's vault", async (createAgent) => {
  const svc = services();
  const getAnchors = vi.fn(async () => []);
  svc.vault = { getAnchors, resolve: vi.fn(), __resetCache: vi.fn() };
  const agent = createAgent(svc);
  await agent.run!({ orgId: "workspace-org", instanceId: "profile", bucket: "drafter", routing: agent.defaultModel, payload: { id: "idea", post_text: "A useful topic", hook: "A useful topic" }, log: () => {} });
  expect(getAnchors).toHaveBeenCalledWith({ orgId: "workspace-org", query: "A useful topic" });
  expect(svc.nella.searchContext).not.toHaveBeenCalled();
});

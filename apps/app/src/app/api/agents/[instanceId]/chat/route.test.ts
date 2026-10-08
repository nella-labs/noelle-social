import { afterEach, beforeEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({ instance: true, append: vi.fn(), call: vi.fn(), cli: vi.fn(), context: vi.fn() }));
const instanceId = "00000000-0000-4000-8000-000000000011";
const orgId = "00000000-0000-4000-8000-000000000001";
const messageId = "00000000-0000-4000-8000-000000000101";
vi.mock("@/lib/queries", () => ({
  getAgentInstance: async () => state.instance ? ({ id: instanceId, org_id: orgId, role: "x_intern", model_overrides: null }) : null,
  loadLatestChatConversation: async () => ({ conversationId: null, messages: [] }),
  loadChatTurnsForModel: async () => [], appendChatTurn: state.append,
}));
vi.mock("@/lib/agent-chat/context", () => ({ loadChatContextForInstance: state.context }));
vi.mock("@noelle/agents/chat", () => ({ tryGetChatProfile: () => ({ systemPrompt: () => "Social writing context" }) }));
vi.mock("@/lib/agent-chat/bedrock-backend", () => ({ BedrockInitError: class extends Error {}, loadBedrockBackend: async () => ({ call: state.call }), serializeError: () => ({}) }));
vi.mock("@noelle/runtime", async original => ({ ...await original<object>(), createClaudeCliBackend: () => ({ call: state.cli }) }));
import { POST } from "./route";
beforeEach(() => {
  state.instance = true; state.append.mockReset().mockResolvedValue(messageId);
  state.call.mockReset().mockResolvedValue({ text: "Try a clearer opening.", usage: {} });
  state.cli.mockReset(); state.context.mockReset().mockResolvedValue({});
  vi.stubEnv("NOELLE_CLAUDE_CLI", "0"); globalThis.__noelleClaudeCliChatBackend = undefined;
});
afterEach(() => { vi.unstubAllEnvs(); globalThis.__noelleClaudeCliChatBackend = undefined; });
const send = () => POST(new Request("http://localhost/chat", { method: "POST", body: JSON.stringify({ message: "Improve this reply." }) }), { params: Promise.resolve({ instanceId }) });
test("social chat persists its actual social owner and bounded context", async () => {
  const wire = await (await send()).json();
  expect(wire.text).toBe("Try a clearer opening.");
  expect(state.context).toHaveBeenCalledWith(expect.objectContaining({ role: "x_intern" }), expect.not.objectContaining({ vaultDigest: expect.anything() }));
  expect(state.append.mock.calls[0]?.[0]).toMatchObject({ expectedOwner: { orgId, role: "x_intern" } });
  expect(state.call.mock.calls[0]?.[0].system).toBe("Social writing context");
});
test("a retired or inaccessible instance cannot call the model", async () => {
  state.instance = false; expect((await send()).status).toBe(404); expect(state.call).not.toHaveBeenCalled();
});
test("an unsolicited vault edit has no live editing authority", async () => {
  state.call.mockResolvedValue({ text: 'Review.\n```noelle-vault-edit\n' + JSON.stringify({ path: "voice.md", content: "Proposed rules", summary: "Edit" }) + '\n```', usage: {} });
  const wire = await (await send()).json();
  expect(wire.vaultEditReceipt).toMatchObject({ eligible: false, refreshReason: "unseen" });
  expect(state.append.mock.calls[0]?.[0].vaultEdit.basis).toBeUndefined();
});

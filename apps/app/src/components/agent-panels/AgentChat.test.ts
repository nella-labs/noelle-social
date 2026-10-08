// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AgentChat } from "./AgentChat";

const actions = vi.hoisted(() => ({ targeting: vi.fn(), vault: vi.fn() }));
vi.mock("@/lib/agent-targeting", () => ({ applyTargetingChange: actions.targeting }));
vi.mock("@/lib/agent-vault", () => ({ applyVaultEdit: actions.vault }));
vi.mock("@/components/constellation/Avatar", () => ({ Avatar: () => null }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface PendingRequest {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  signal: AbortSignal | null | undefined;
  resolve: (response: Response) => void;
}
let host: HTMLDivElement;
let root: Root;
let requests: PendingRequest[];
const defaults = { agentId: "x-intern", agentRole: "x-intern", agentName: "Vega", instanceId: "instance-a", orgSlug: "workspace-a" };
const proposal = { addHandles: ["example"], removeHandles: [], addKeywords: [], removeKeywords: [], addPeople: [], removePeople: [] };
const edit = { path: "voice-spec.md", content: "Keep sentences short.", summary: "Shorter sentences" };
const receipt = { messageId: "00000000-0000-4000-8000-000000000101", eligible: true, refreshReason: null };
const posts = () => requests.filter((r) => r.method === "POST");
const gets = () => requests.filter((r) => r.method === "GET");
function button(label: string): HTMLButtonElement {
  const node = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!node) throw new Error(`Missing button ${label}`);
  return node;
}
async function render(props: Partial<Parameters<typeof AgentChat>[0]> = {}) {
  await act(async () => root.render(createElement(AgentChat, { ...defaults, ...props })));
}
async function reply(request: PendingRequest, payload: unknown, status = 200) {
  await act(async () => request.resolve(new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })));
}
async function type(text: string) {
  await act(async () => {
    const input = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(label: string) { await act(async () => button(label).click()); }
async function startTurn(payload?: unknown) {
  await type("Help with the next post"); await click("Send ↵");
  if (payload) await reply(posts().at(-1)!, payload);
}
beforeEach(() => {
  requests = []; actions.targeting.mockReset(); actions.vault.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve) => {
    requests.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, signal: init?.signal, resolve });
  })));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("keyboard and same-render clicks cannot dispatch another turn while a reply is pending", async () => {
  await render(); await reply(gets()[0]!, { greeting: { body: "Ready", suggestions: [] } });
  await type("First turn");
  await act(async () => { const send = button("Send ↵"); send.click(); send.click(); });
  await type("Second turn");
  await act(async () => host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })));
  expect(posts()).toHaveLength(1);
});

test("New chat discards an old reply and does not attach its conversation to the next turn", async () => {
  await render(); await startTurn(); const old = posts()[0]!;
  await click("New chat"); await reply(gets().at(-1)!, { greeting: { body: "Fresh greeting", suggestions: [] } });
  await reply(old, { text: "Old conversation answer", conversationId: "old-conversation" });
  expect(host.textContent).not.toContain("Old conversation answer");
  await startTurn(); expect(posts().at(-1)!.body?.conversationId).toBeNull();
});

test("an old instance response cannot appear under a new agent identity", async () => {
  await render(); await startTurn(); const old = posts()[0]!;
  await render({ instanceId: "instance-b", agentName: "Lyra", agentRole: "linkedin-intern" });
  await reply(gets().at(-1)!, { greeting: { body: "Lyra ready", suggestions: [] } });
  await reply(old, { text: "Vega private reply", conversationId: "vega-conversation" });
  expect(host.textContent).not.toContain("Vega private reply");
  expect(host.textContent).not.toContain("Help with the next post");
  await startTurn(); expect(posts().at(-1)!.url).toContain("instance-b"); expect(posts().at(-1)!.body?.conversationId).toBeNull();
});

test("an old greeting/history cannot restore a thread after New chat", async () => {
  await render(); const old = gets()[0]!;
  await click("New chat"); await reply(gets()[1]!, { greeting: { body: "Fresh", suggestions: [] } });
  await reply(old, { conversationId: "historical-thread", messages: [{ who: "agent", at: "yesterday", body: "Old history" }] });
  expect(host.textContent).not.toContain("Old history");
  await startTurn(); expect(posts()[0]!.body?.conversationId).toBeNull();
});

test("a late resumed greeting cannot change the conversation of an already started turn", async () => {
  await render(); const old = gets()[0]!; await startTurn();
  await reply(posts()[0]!, { text: "Fresh answer", conversationId: "fresh-thread" });
  await reply(old, { conversationId: "historical-thread", messages: [{ who: "agent", at: "yesterday", body: "Old history" }] });
  await startTurn(); expect(posts()[1]!.body?.conversationId).toBe("fresh-thread");
});

test("an old error cannot expose Retry or clear the new conversation's pending state", async () => {
  await render(); await startTurn(); const old = posts()[0]!;
  await click("New chat"); await startTurn();
  await reply(old, { error: "backend_unavailable" }, 503);
  expect(host.textContent).not.toContain("Retry"); expect(button("Send ↵").disabled).toBe(true);
  await reply(posts()[1]!, { text: "Current answer" }); expect(host.textContent).toContain("Current answer");
});

test("a constrained script response from another draft cannot edit the current studio", async () => {
  const apply = vi.fn(); await render({ draftId: "draft-a", onApplyScriptEdit: apply });
  await startTurn({ text: "Suggested rewrite" }); await click("✎ Apply to script"); const old = posts().at(-1)!;
  await render({ draftId: "draft-b", onApplyScriptEdit: apply });
  await reply(old, { scriptEdit: { fullScript: "Old draft rewrite", summary: "Rewrite" } });
  expect(apply).not.toHaveBeenCalled(); expect(host.textContent).not.toContain("dropped those changes");
});

test("targeting Apply is reserved synchronously and its old completion cannot acknowledge a new chat", async () => {
  let finish!: (value: unknown) => void; actions.targeting.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await render(); await startTurn({ text: "Proposed target", proposal });
  await act(async () => { const apply = button("Apply"); apply.click(); apply.click(); });
  expect(actions.targeting).toHaveBeenCalledTimes(1);
  await click("New chat");
  await act(async () => finish({ ok: true, applied: { addedHandles: 1, removedHandles: 0, addedKeywords: 0, removedKeywords: 0, addedPeople: 0, removedPeople: 0, addedSubreddits: 0, removedSubreddits: 0, missionChanged: false } }));
  expect(host.textContent).not.toContain("Done —");
});

test("vault Apply completion cannot acknowledge a different instance", async () => {
  let finish!: (value: unknown) => void; actions.vault.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await render({ agentRole: "cmo" }); await startTurn({ text: "Proposed vault change", vaultEdit: edit, vaultEditReceipt: receipt }); await click("Apply to vault");
  await render({ instanceId: "instance-b", agentRole: "cmo" });
  await act(async () => finish({ ok: true, path: "voice-spec.md" }));
  expect(host.textContent).not.toContain("Done — updated");
});

test("structured action failure keeps the proposal pending without a success acknowledgment", async () => {
  actions.targeting.mockResolvedValue({ ok: false, error: "forbidden" });
  await render(); await startTurn({ text: "Proposed target", proposal }); await click("Apply");
  expect(host.textContent).toContain("You don't have permission"); expect(host.textContent).not.toContain("Change applied");
  expect(button("Apply").disabled).toBe(false);
});

test("a synchronous script card can apply only once before React commits", async () => {
  const apply = vi.fn(() => true); await render({ onApplyScriptEdit: apply });
  await startTurn({ text: "Proposed rewrite", scriptEdit: { fullScript: "New script", summary: "Rewrite" } });
  await act(async () => { const submit = button("Apply to draft"); submit.click(); submit.click(); });
  expect(apply).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Loaded into the editor");
});

test.each([false, "throw"])("a script callback reporting %s does not acknowledge an edit", async (result) => {
  const apply = vi.fn(() => { if (result === "throw") throw new Error("Editor rejected edit"); return false; });
  await render({ onApplyScriptEdit: apply });
  await startTurn({ text: "Proposed rewrite", scriptEdit: { fullScript: "New script", summary: "Rewrite" } }); await click("Apply to draft");
  expect(host.textContent).not.toContain("Loaded into the editor");
  expect(host.textContent).not.toContain("Done —"); expect(button("Apply to draft").disabled).toBe(false);
});

test("reset aborts outstanding local requests while ignored abort completions remain guarded", async () => {
  await render(); await startTurn(); const original = [...requests];
  await click("New chat"); expect(original.every((r) => r.signal?.aborted)).toBe(true);
  expect(gets().at(-1)!.signal?.aborted).toBe(false);
});

test("a constrained script request also requires an acknowledged editor change", async () => {
  await render({ onApplyScriptEdit: () => false }); await startTurn({ text: "Suggested rewrite" }); await click("✎ Apply to script");
  await reply(posts().at(-1)!, { scriptEdit: { fullScript: "Same script", summary: "Rewrite" } });
  expect(host.textContent).toContain("didn't change the current draft"); expect(host.textContent).not.toContain("Done —");
});

test("a current targeting action is acknowledged only after the server reports success", async () => {
  actions.targeting.mockResolvedValue({ ok: true, applied: { addedHandles: 1, removedHandles: 0, addedKeywords: 0, removedKeywords: 0, addedPeople: 0, removedPeople: 0, addedSubreddits: 0, removedSubreddits: 0, missionChanged: false } });
  await render(); await startTurn({ text: "Proposed target", proposal }); await click("Apply");
  expect(host.textContent).toContain("Change applied"); expect(host.textContent).toContain("added 1 target");
});


test("Reddit proposals show communities and acknowledge actual persisted counts", async () => {
  const communities = { ...proposal, addHandles: [], addSubreddits: ["saas"], removeSubreddits: ["startups"] };
  await render({ agentRole: "reddit-intern", agentId: "reddit-intern" });
  await startTurn({ text: "Review these communities", proposal: communities });
  expect(host.textContent).toContain("r/saas"); expect(host.textContent).toContain("r/startups");
  actions.targeting.mockResolvedValue({ ok: true, applied: { addedHandles: 0, removedHandles: 0, addedKeywords: 0, removedKeywords: 0, addedPeople: 0, removedPeople: 0, addedSubreddits: 1, removedSubreddits: 0, missionChanged: false } });
  await click("Apply");
  expect(actions.targeting).toHaveBeenCalledWith(expect.objectContaining({ proposal: expect.objectContaining(communities) }));
  expect(host.textContent).toContain("added 1 target"); expect(host.textContent).not.toContain("removed 1 target");
});

test("a deduplicated no-op does not claim a targeting change", async () => {
  await render(); await startTurn({ text: "Review this target", proposal });
  actions.targeting.mockResolvedValue({ ok: true, applied: { addedHandles: 0, removedHandles: 0, addedKeywords: 0, removedKeywords: 0, addedPeople: 0, removedPeople: 0, addedSubreddits: 0, removedSubreddits: 0, missionChanged: false } });
  await click("Apply"); expect(host.textContent).toContain("already matched your targeting");
});


test("mixed-platform proposals remain visible but cannot invoke the write action", async () => {
  await render({ agentRole: "reddit-intern", agentId: "reddit-intern" });
  await startTurn({ text: "Review these targets", proposal: { ...proposal, addSubreddits: ["saas"], removeSubreddits: [] } });
  expect(host.textContent).toContain("@example"); expect(host.textContent).toContain("r/saas");
  expect(button("Apply").disabled).toBe(true);
  await click("Apply"); expect(actions.targeting).not.toHaveBeenCalled();
});

test("a success response missing committed counts leaves the proposal pending", async () => {
  await render(); await startTurn({ text: "Review this target", proposal });
  actions.targeting.mockResolvedValue({ ok: true }); await click("Apply");
  expect(host.textContent).not.toContain("Change applied");
  expect(host.textContent).toContain("Couldn't apply that change");
  expect(button("Apply").disabled).toBe(false);
});

test("vault Apply sends only the persisted message identifier and acknowledges confirmed success", async () => {
  actions.vault.mockResolvedValue({ ok: true, path: edit.path });
  await render({ agentRole: "cmo" });
  await startTurn({ text: "Review it", vaultEdit: edit, vaultEditReceipt: receipt });
  await click("Apply to vault");
  expect(actions.vault).toHaveBeenCalledWith({ orgSlug: defaults.orgSlug, instanceId: defaults.instanceId, messageId: receipt.messageId });
  expect(host.textContent).toContain("Written to your vault");
});
test("an unbased vault edit offers one explicit refresh through the existing chat request", async () => {
  await render({ agentRole: "cmo" });
  await startTurn({ text: "Review it", vaultEdit: edit, vaultEditReceipt: { ...receipt, eligible: false, refreshReason: "partial" } });
  expect(button("Apply to vault").disabled).toBe(true);
  await act(async () => { const refresh = button("Refresh file"); refresh.click(); refresh.click(); });
  expect(posts()).toHaveLength(2);
  expect(posts()[1]?.body).toMatchObject({ vaultPath: edit.path });
  expect(actions.vault).not.toHaveBeenCalled();
  expect(button("Send ↵").disabled).toBe(true);
});
test("a stale-source rejection requires refresh and never acknowledges a write", async () => {
  actions.vault.mockResolvedValue({ ok: false, error: "conflict" });
  await render({ agentRole: "cmo" });
  await startTurn({ text: "Review it", vaultEdit: edit, vaultEditReceipt: receipt });
  await click("Apply to vault");
  expect(host.textContent).toContain("changed since this proposal");
  expect(host.textContent).not.toContain("Written to your vault");
  expect(button("Apply to vault").disabled).toBe(true);
  expect(button("Refresh file").disabled).toBe(false);
});
test("the vault card permits review of the complete candidate beyond the old preview cutoff", async () => {
  await render({ agentRole: "cmo" });
  await startTurn({ text: "Review it", vaultEdit: { ...edit, content: "x".repeat(700) + "END OF COMPLETE FILE" }, vaultEditReceipt: receipt });
  expect(host.querySelector("pre")?.textContent).toContain("END OF COMPLETE FILE");
});
test("Retry preserves an explicit file refresh and its complete-source request", async () => {
  await render({ agentRole: "cmo" });
  await startTurn({ text: "Review it", vaultEdit: edit, vaultEditReceipt: { ...receipt, eligible: false, refreshReason: "partial" } });
  await click("Refresh file");
  await reply(posts().at(-1)!, { error: "model_error" }, 502);
  await click("Retry");
  expect(posts().at(-1)?.body).toMatchObject({ vaultPath: edit.path });
});

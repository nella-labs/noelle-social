// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ObjectiveCard } from "./ObjectiveCard";

const actions = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/lib/agent-targeting", () => ({ updateObjective: actions.save }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement, root: Root;
const original = { orgSlug: "fixture", instanceId: "00000000-0000-4000-8000-000000000011", agentName: "Vega", mission: "Custom operator objective", isCustom: true };
const defaults = { mission: "Built-in mission from the server resolver", isCustom: false };
beforeEach(() => { actions.save.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function render(props: Partial<Parameters<typeof ObjectiveCard>[0]> = {}) { await act(async () => root.render(createElement(ObjectiveCard, { ...original, ...props }))); }
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((row) => row.textContent === label);
  if (!button) throw new Error(`Missing button ${label}`);
  await act(async () => button.click());
}
async function type(value: string) {
  await act(async () => {
    const input = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const mission = () => host.querySelector("p.serif")?.textContent;

test("a confirmed clear waits for the resolved default without relabeling the former custom text", async () => {
  actions.save.mockResolvedValue({ ok: true, objective: null });
  await render(); await click("Edit"); await click("Reset to default"); await click("Save");
  expect(actions.save).toHaveBeenCalledWith({ orgSlug: original.orgSlug, instanceId: original.instanceId, objective: "" });
  expect(mission()).toBe(original.mission);
  expect(host.textContent).toContain("set by you");
  expect(host.textContent).not.toContain("default brief · edit to make it yours");
});

test("revalidated default props update the preserved component and initialize an empty edit", async () => {
  actions.save.mockResolvedValue({ ok: true, objective: null });
  await render(); await click("Edit"); await click("Reset to default"); await click("Save"); await render(defaults);
  expect(mission()).toBe(defaults.mission); expect(host.textContent).toContain("default brief · edit to make it yours");
  await click("Edit"); expect(host.querySelector("textarea")?.value).toBe("");
});

test("another surface's confirmed custom props update the display and the next edit", async () => {
  await render(); await render({ mission: "New confirmed objective" });
  expect(mission()).toBe("New confirmed objective");
  await click("Edit"); expect(host.querySelector("textarea")?.value).toBe("New confirmed objective");
});

test("an unrelated server refresh preserves an in-progress edit, then reopening uses current props", async () => {
  await render(); await click("Edit"); await type("Unfinished operator draft"); await render({ mission: "Updated confirmed objective" });
  expect(host.querySelector("textarea")?.value).toBe("Unfinished operator draft");
  await click("Cancel"); expect(mission()).toBe("Updated confirmed objective");
  await click("Edit"); expect(host.querySelector("textarea")?.value).toBe("Updated confirmed objective");
});

test("a successful custom save displays only confirmed server props", async () => {
  actions.save.mockResolvedValue({ ok: true, objective: "New objective" });
  await render(); await click("Edit"); await type("New objective"); await click("Save");
  expect(mission()).toBe(original.mission);
  await render({ mission: "New objective" }); expect(mission()).toBe("New objective");
});

test("pending save disables its controls and preserves the draft across a server refresh", async () => {
  let finish!: (value: unknown) => void;
  actions.save.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await render(); await click("Edit"); await type("Unfinished operator draft"); await click("Save"); await render(defaults);
  expect(host.querySelector("textarea")?.value).toBe("Unfinished operator draft");
  expect([...host.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  await act(async () => finish({ ok: false, error: "not_found" }));
  expect(host.querySelector("textarea")?.value).toBe("Unfinished operator draft");
  expect(host.textContent).toContain("Couldn't save.");
});

test("a known failed reset keeps the editor open without a false default label", async () => {
  actions.save.mockResolvedValue({ ok: false, error: "not_found" });
  await render(); await click("Edit"); await click("Reset to default"); await click("Save");
  expect(host.querySelector("textarea")).not.toBeNull(); expect(host.textContent).toContain("Couldn't save.");
  expect(host.textContent).not.toContain("default brief · edit to make it yours");
});

test("an absent instance remains read-only", async () => {
  await act(async () => root.render(createElement(ObjectiveCard, { orgSlug: original.orgSlug, agentName: original.agentName, ...defaults })));
  expect(host.querySelector("button")).toBeNull(); expect(mission()).toBe(defaults.mission);
});

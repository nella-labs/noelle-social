// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PatternAlertBanner, type PatternAlertItem } from "./PatternAlertBanner";
const actions = vi.hoisted(() => ({ refine: vi.fn(), revert: vi.fn(), ack: vi.fn() }));
vi.mock("@/app/app/[orgSlug]/approvals/actions", () => ({
  refinePatternAlert: actions.refine,
  revertPatternAlert: actions.revert,
  acknowledgePatternAlert: actions.ack,
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const item: PatternAlertItem = {
  id: "00000000-0000-4000-8000-000000000001",
  ruleId: "00000000-0000-4000-8000-000000000002",
  patternName: "stock closer",
  description: "Recent replies use a stock closer",
  severity: "medium",
  windowSize: 10,
  frequencyCount: 4,
  examples: [],
  status: "open",
  ruleInstruction: "Avoid using a stock closer",
  suggestion: null,
  refineNote: null,
};
const requestId = "00000000-0000-4000-8000-000000000003";
async function render(alerts: PatternAlertItem[] = [item], expand = true) {
  await act(async () => root.render(createElement(PatternAlertBanner, { orgSlug: "one", alerts })));
  if (expand && host.querySelector('[role="alert"]')) await click("Review pattern");
}
function button(label: string) {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!found) throw Error(`Missing ${label}`);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  for (const fn of Object.values(actions)) fn.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
test("expands and collapses the notice without mutating a pattern", async () => {
  await render([item], false);
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  expect(host.textContent).toContain("stock closer");
  expect(host.textContent).toContain("Pattern breaker · 1");
  await click("Review pattern");
  expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(host.textContent).toContain("Recent replies use a stock closer");
  expect(document.activeElement).toBe(host.querySelector('button[aria-label="Collapse pattern"]'));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Collapse pattern"]')?.click());
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  expect(document.activeElement).toBe(button("Review pattern"));
  await click("Review pattern");
  expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
  for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
});
test("a claimed request offers explicit retry and does not claim a running model", async () => {
  await render([
    {
      ...item,
      status: "refining",
      refineRequestId: requestId,
      refineClaimed: true,
    } as PatternAlertItem,
  ]);
  expect(host.textContent).toContain("Awaiting refinement result");
  expect(host.textContent).not.toContain("Refining with AI");
  await click("Retry refinement");
  actions.refine.mockResolvedValue({
    ok: true,
    status: "refining",
    refineRequestId: "00000000-0000-4000-8000-000000000004",
  });
  await click("Retry with AI");
  expect(actions.refine).toHaveBeenCalledWith(
    expect.objectContaining({ expectedRequestId: requestId }),
  );
});
test("a failed refinement preserves the rule and exposes retry", async () => {
  await render([
    {
      ...item,
      refineRequestId: requestId,
      refineClaimed: true,
      refineFailed: true,
    } as PatternAlertItem,
  ]);
  expect(host.textContent).toContain("The original rule is unchanged");
  expect(button("Retry refinement")).toBeTruthy();
});
test("structured failure retains the card", async () => {
  await render();
  actions.revert.mockResolvedValue({ ok: false, error: { message: "The request changed" } });
  await click("Revert");
  expect(host.textContent).toContain("The request changed");
  expect(host.textContent).toContain("stock closer");
});
test("throws display a failure rather than removing the card", async () => {
  await render();
  actions.revert.mockRejectedValue(Error("Unavailable"));
  await click("Revert");
  expect(host.textContent).toContain("Unavailable");
  expect(host.textContent).toContain("stock closer");
});
test("simultaneous clicks reserve one action until the state commits", async () => {
  await render();
  let finish!: (value: unknown) => void;
  actions.revert.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    button("Revert").click();
    button("Revert").click();
  });
  expect(actions.revert).toHaveBeenCalledTimes(1);
  await act(async () => finish({ ok: true, status: "reverted" }));
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
});
test("old acknowledgment cannot remove the next current card", async () => {
  await render();
  let finish!: (value: unknown) => void;
  actions.ack.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click("Keep");
  await render([
    { ...item, id: "00000000-0000-4000-8000-000000000009", patternName: "Current card" },
  ]);
  await act(async () => finish({ ok: true, status: "acknowledged" }));
  expect(host.textContent).toContain("Current card");
});

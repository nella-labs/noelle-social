// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { BudgetCapField } from "./BudgetCapField";
import { StepperField } from "./StepperField";
import { PercentPicker } from "./PercentPicker";
import { SwitchField } from "./SwitchField";
import { RangeWithLabel } from "./RangeWithLabel";
import { SaveBar } from "./SaveBar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
function button(label: string) {
  const found = Array.from(host.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
async function render(control: ReactNode) {
  await act(async () => root.render(createElement("form", null,
    control, createElement(SaveBar, { canEdit: true, helpClean: "Clean", helpDirty: "Dirty" }))));
}
async function reset() {
  expect(button("Revert").disabled).toBe(false);
  await act(async () => { button("Revert").click(); await new Promise((resolve) => setTimeout(resolve, 5)); });
  expect(button("Revert").disabled).toBe(true);
}

test.each([
  { control: createElement(BudgetCapField, { defaultCents: 2500, minCents: 2500, maxCents: 200000, stepCents: 500 }), button: "$100", name: "budgetCapCents", initial: "2500", changed: "10000" },
  { control: createElement(StepperField, { name: "maxPerHour", min: 1, max: 30, step: 1, defaultValue: 5 }), button: "+", name: "maxPerHour", initial: "5", changed: "6" },
  { control: createElement(PercentPicker, { name: "alertPct", options: [50, 75, 90, 100], defaultValue: 75 }), button: "90%", name: "alertPct", initial: "75", changed: "90" },
])("Revert restores controlled $name and the original form baseline", async (fixture) => {
  await render(fixture.control);
  const form = host.querySelector("form")!;
  await act(async () => button(fixture.button).click());
  expect(new FormData(form).get(fixture.name)).toBe(fixture.changed);
  await reset();
  expect(new FormData(form).get(fixture.name)).toBe(fixture.initial);
  await act(async () => button(fixture.button).click());
  expect(button("Revert").disabled).toBe(false);
});

test("Revert restores a controlled switch's submitted value and visible label", async () => {
  await render(createElement(SwitchField, { name: "send", defaultChecked: true }));
  await act(async () => host.querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
  expect(new FormData(host.querySelector("form")!).get("send")).toBeNull();
  expect(host.textContent).toContain("Off");
  await reset();
  expect(new FormData(host.querySelector("form")!).get("send")).toBe("true");
  expect(host.textContent).toContain("On");
});

test("Revert restores a controlled range and its displayed value", async () => {
  await render(createElement(RangeWithLabel, { name: "delay", min: 0, max: 100, step: 1, defaultValue: 10, format: "duration" }));
  const input = host.querySelector<HTMLInputElement>("input[type=range]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "20");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.textContent).toContain("20s");
  await reset();
  expect(new FormData(host.querySelector("form")!).get("delay")).toBe("10");
  expect(host.textContent).toContain("10s");
});

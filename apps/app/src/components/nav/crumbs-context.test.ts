// @vitest-environment jsdom

import { act, Component, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrumbsProvider, useCrumbOverrides, useSetCrumb } from "./crumbs-context";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let renders: number;
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? createElement("span", null, "render limit reached") : this.props.children; }
}
function Label({ label }: { label: string | null }) {
  useSetCrumb("instance", label);
  if (++renders > 20) throw new Error("bounded breadcrumb render limit");
  return null;
}
function Readout() {
  return createElement("span", null, useCrumbOverrides().instance ?? "unset");
}
async function render(label: string | null, mounted = true) {
  await act(async () => root.render(createElement(Boundary, null, createElement(CrumbsProvider, null,
    mounted ? createElement(Label, { label }) : null, createElement(Readout)))));
}
beforeEach(() => {
  renders = 0; host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

test("a mounted breadcrumb settles and updates without a context-effect render loop", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await render("Friendly agent");
  expect(host.textContent).toBe("Friendly agent");
  expect(renders).toBeLessThan(5);
  await render("Updated agent");
  expect(host.textContent).toBe("Updated agent");
  expect(renders).toBeLessThan(10);
  await render(null, false);
  expect(host.textContent).toBe("unset");
});

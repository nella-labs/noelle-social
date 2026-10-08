// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ org: vi.fn(), refresh: vi.fn(), revalidate: vi.fn(), cookie: { get: vi.fn(), set: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: fixture.refresh }) }));
vi.mock("next/headers", () => ({ cookies: async () => fixture.cookie }));
vi.mock("next/cache", () => ({ revalidatePath: fixture.revalidate }));
vi.mock("@/lib/queries", () => ({ getOrgBySlug: fixture.org }));
import { DismissGuided } from "./DismissGuided";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.org.mockReset().mockResolvedValue({ id: "org" });
  fixture.refresh.mockReset(); fixture.revalidate.mockReset(); fixture.cookie.get.mockReset(); fixture.cookie.set.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function mount(dismissed = false) {
  await act(async () => root.render(createElement(DismissGuided, { orgSlug: "selected", dismissed, label: dismissed ? "Show" : "Hide" })));
  return host.querySelector<HTMLButtonElement>("button")!;
}
test.each([false, true])("failed actual hide/show receipt with dismissed=%s stays visible without refresh", async dismissed => {
  fixture.org.mockResolvedValue(null); const button = await mount(dismissed);
  await act(async () => button.click());
  expect(fixture.refresh).not.toHaveBeenCalled(); expect(fixture.cookie.set).not.toHaveBeenCalled(); expect(fixture.revalidate).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/could not|unable/i); expect(button.disabled).toBe(false);
});
test("confirmed action changes existing cookie and refreshes once", async () => {
  const button = await mount(); await act(async () => button.click());
  expect(fixture.cookie.set).toHaveBeenCalledTimes(1); expect(fixture.revalidate).toHaveBeenCalledTimes(2);
  expect(fixture.refresh).toHaveBeenCalledTimes(1); expect(host.querySelector('[role="alert"]')).toBeNull();
});
test("thrown cookie persistence failure is visible and does not refresh", async () => {
  fixture.cookie.set.mockImplementation(() => { throw new Error("inert cookie failure"); });
  const button = await mount(); await act(async () => button.click());
  expect(fixture.refresh).not.toHaveBeenCalled(); expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/could not|unable/i);
});
test("pending admission disables the control before duplicate clicks", async () => {
  let resolve!: (value: null) => void;
  fixture.org.mockReturnValue(new Promise<null>(finish => { resolve = finish; }));
  const button = await mount(); await act(async () => button.click());
  expect(button.disabled).toBe(true); button.click(); expect(fixture.org).toHaveBeenCalledTimes(1);
  await act(async () => resolve(null)); expect(button.disabled).toBe(false); expect(fixture.refresh).not.toHaveBeenCalled();
});

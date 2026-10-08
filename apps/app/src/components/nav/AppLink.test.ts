// @vitest-environment jsdom

/**
 * Tests the dead-<Link> fix (vercel/next.js #57565 / #88032): when the App
 * Router client navigation wedges, router.push() is a no-op and the URL never
 * changes — AppLink must detect that and hard-navigate so the click is never
 * lost. It must also leave modifier/middle clicks and external links to the
 * browser.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const push = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push,
    replace,
    prefetch: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
}));

import { AppLink } from "./AppLink";

let container: HTMLDivElement;
let root: Root;
let originalLocation: Location;
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  push.mockReset();
  replace.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom's window.location isn't spyable, so swap in a controllable stand-in.
  originalLocation = window.location;
  assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { pathname: "/", search: "", hash: "", href: "http://localhost/", assign, replace: vi.fn() },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
  vi.useRealTimers();
});

function clickWith(init: MouseEventInit) {
  const a = container.querySelector("a")!;
  act(() => {
    a.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }),
    );
  });
  return a;
}

test("plain left-click routes via router.push, then hard-navigates when the router wedges (URL never changes)", () => {
  act(() => {
    root.render(createElement(AppLink, { href: "/app/operator/agents/vega" }, "Open"));
  });
  clickWith({});
  expect(push).toHaveBeenCalledWith("/app/operator/agents/vega");
  expect(assign).not.toHaveBeenCalled(); // fallback timer still pending
  act(() => {
    vi.advanceTimersByTime(300);
  });
  // push was a no-op (URL unchanged) → the wedge fallback fires.
  expect(assign).toHaveBeenCalledWith("/app/operator/agents/vega");
});

test("when router.push works (URL changes), the hard-nav fallback does NOT fire", () => {
  act(() => {
    root.render(createElement(AppLink, { href: "/app/operator/settings" }, "Settings"));
  });
  // Simulate a healthy router: push updates the URL.
  push.mockImplementation(() => {
    (window.location as unknown as { pathname: string }).pathname = "/app/operator/settings";
  });
  clickWith({});
  expect(push).toHaveBeenCalledWith("/app/operator/settings");
  act(() => {
    vi.advanceTimersByTime(300);
  });
  expect(assign).not.toHaveBeenCalled();
});

test("modifier-click (cmd/ctrl) is left to the browser — no push, no fallback", () => {
  act(() => {
    root.render(createElement(AppLink, { href: "/app/operator" }, "Open"));
  });
  clickWith({ metaKey: true });
  act(() => {
    vi.advanceTimersByTime(300);
  });
  expect(push).not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();
});

test("external (non-/) href is not intercepted", () => {
  act(() => {
    root.render(createElement(AppLink, { href: "https://example.com" }, "Out"));
  });
  clickWith({});
  expect(push).not.toHaveBeenCalled();
});

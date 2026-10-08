// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { XInternStream } from "./XInternStream";
import { LinkedInStream } from "./LinkedInStream";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

test("LinkedIn presents every pending reply as already approved for the actor", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(LinkedInStream, {
    reviewSlot: createElement("div"), speedrunDrafts: [], basePath: "/app/a/approvals",
    orgSlug: "a", pending: 17, dmCount: 139,
    configureHref: "/app/a/agents/li/config",
  })));
  expect(host.textContent).toContain("Approved replies · 17");
  expect(host.textContent).toContain("Automatic review passed · actor sends within its send controls");
  expect(host.textContent).not.toContain("Ready for actor");
  expect(host.textContent).not.toContain("DMs · 139");
  act(() => root.unmount());
  host.remove();
});

test("X presents every pending reply as already approved for the actor", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(XInternStream, {
    reviewSlot: createElement("div"), speedrunDrafts: [], basePath: "/app/a/approvals",
    orgSlug: "a", totalPending: 21, totalDms: 2,
    configureHref: "/app/a/agents/x/config",
  })));
  expect(host.textContent).toContain("Approved replies · 21");
  expect(host.textContent).toContain("Automatic review passed · actor sends within its send controls");
  expect(host.textContent).not.toContain("Ready for actor");
  expect(host.textContent).not.toContain("DMs · 2");
  act(() => root.unmount());
  host.remove();
});

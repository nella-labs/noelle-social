// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/app/demo/approvals",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { NavRail } from "./NavRail";
import { MobileNav } from "./MobileNav";
import { ThemeProvider } from "../theme/ThemeProvider";
import { LoginScreen } from "../auth/LoginScreen";

const props = {
  orgSlug: "demo",
  org: { name: "Demo" },
  user: { name: "Demo", handle: "@demo" },
  logoutAction: () => {},
};

function render(element: React.ReactElement) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(element);
  return container;
}

describe("Noelle branding", () => {
  it.each([
    ["desktop rail", createElement(NavRail, props)],
    ["mobile drawer", createElement(NavRail, { ...props, variant: "drawer" })],
    ["phone header", createElement(ThemeProvider, null, createElement(MobileNav, props))],
  ])("keeps the accessible lockup linked to overview in the %s", (_name, element) => {
    const container = render(element);
    const link = container.querySelector('a[aria-label="Noelle overview"]');
    expect(link?.getAttribute("href")).toBe("/app/demo");
    expect(link?.querySelector('[role="img"][aria-label="Noelle"]')).not.toBeNull();
  });

  it("keeps the sign in lockup linked to the public product page", () => {
    const container = render(createElement(LoginScreen));
    const link = container.querySelector('a[aria-label="About Noelle"]');
    expect(link?.getAttribute("href")).toBe("/about");
    expect(link?.querySelector('[role="img"][aria-label="Noelle"]')).not.toBeNull();
  });
});

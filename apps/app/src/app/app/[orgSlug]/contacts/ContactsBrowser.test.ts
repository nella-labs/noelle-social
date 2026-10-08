// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PersonListItem } from "@/lib/queries";
import { ContactsBrowser } from "./ContactsBrowser";

vi.mock("@/components/nav/AppLink", () => ({ AppLink: ({ children, ...props }: { children: ReactNode }) => createElement("a", props, children) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const person = (id: string, overrides: Partial<PersonListItem>): PersonListItem => ({ id, displayName: id, xHandle: null, linkedinHandle: null, platforms: [], repliesSent: 0, pendingReplies: 0, lastInteractionAt: null, watchedBy: [], ...overrides });
const people = [person("Alice", { xHandle: "alice", platforms: ["x"], watchedBy: ["Vega"] }), person("Sam", { linkedinHandle: "sam", platforms: ["linkedin"], watchedBy: ["Lyra"], repliesSent: 4 }), person("Chris", { linkedinHandle: "chris", platforms: ["linkedin"] })];
beforeEach(async () => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root.render(createElement(ContactsBrowser, { orgSlug: "workspace", people, styleSourceKeys: ["linkedin:sam"] }))); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function click(label: string) { const button = [...host.querySelectorAll("button")].find((node) => node.textContent === label); expect(button).toBeDefined(); await act(async () => button!.click()); }

test("watchlist and platform filters intersect while preserving contact links and style membership", async () => {
  await click("Watched 2"); await click("LinkedIn 2");
  const rows = [...host.querySelectorAll("li")];
  expect(rows).toHaveLength(1);
  expect(rows[0]?.textContent).toContain("Sam");
  expect(rows[0]?.textContent).toContain("Style source");
  expect(rows[0]?.querySelector("a")?.getAttribute("href")).toBe("/app/workspace/contacts/Sam");
});
test("an empty intersection can clear all filters and restore the complete contact list", async () => {
  await click("Not watched 1"); await click("X 1");
  expect(host.querySelectorAll("li")).toHaveLength(0);
  await click("Clear filters");
  expect(host.querySelectorAll("li")).toHaveLength(3);
});

const largeRoster = Array.from({ length: 235 }, (_, index) => person(`Person ${index}`, { xHandle: `person${index}`, platforms: ["x"], watchedBy: index < 150 ? ["Vega"] : [] }));
async function renderRoster(roster: PersonListItem[]) { await act(async () => root.render(createElement(ContactsBrowser, { orgSlug: "workspace", people: roster }))); }
async function searchFor(value: string) {
  const input = host.querySelector<HTMLInputElement>('[aria-label="Search contacts"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("contact paging bounds the DOM while keeping complete counts and searching beyond the current page", async () => {
  await renderRoster(largeRoster);
  expect(host.querySelectorAll("li")).toHaveLength(100);
  expect(host.textContent).toContain("235 contacts");
  expect(host.textContent).toContain("1–100 of 235");
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Previous page"]')?.disabled).toBe(true);
  await click("Next");
  expect(host.querySelectorAll("li")).toHaveLength(100);
  expect(host.textContent).toContain("101–200 of 235");
  await click("Next");
  expect(host.querySelectorAll("li")).toHaveLength(35);
  expect(host.textContent).toContain("201–235 of 235");
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Next page"]')?.disabled).toBe(true);
  await searchFor("person234");
  expect(host.querySelectorAll("li")).toHaveLength(1);
  expect(host.textContent).toContain("Person 234");
  expect(host.textContent).toContain("1 / 235 contacts");
  expect(host.textContent).toContain("Page 1 of 1");
});

test("watchlist filters reset paging and refreshed results clamp it without restoring a stale page", async () => {
  await renderRoster(largeRoster);
  await click("Next"); await click("Next");
  await click("Watched 150");
  expect(host.querySelectorAll("li")).toHaveLength(100);
  expect(host.textContent).toContain("1–100 of 150");
  await click("All 235"); await click("Next"); await click("Next");
  await renderRoster(largeRoster.slice(0, 135));
  expect(host.querySelectorAll("li")).toHaveLength(35);
  expect(host.textContent).toContain("Page 2 of 2");
  await renderRoster(largeRoster);
  expect(host.querySelectorAll("li")).toHaveLength(100);
  expect(host.textContent).toContain("Page 2 of 3");
});

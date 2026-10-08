// @vitest-environment jsdom
import { act, createElement } from "react";
import http from "node:http";
import https from "node:https";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { VaultBrowser } from "./VaultBrowser";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const file = { type: "file" as const, name: "voice-spec.md", path: "voice-spec.md", lastModifiedISO: "2026-10-05T00:00:00Z" };
beforeEach(() => {
  vi.spyOn(http, "request").mockImplementation(() => { throw new Error("HTTP forbidden in component tests"); });
  vi.spyOn(https, "request").mockImplementation(() => { throw new Error("HTTPS forbidden in component tests"); });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Fetch forbidden in component tests"); }));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
test("an oversized-file response explains the preview bound instead of claiming missing contents", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "too_large", message: "This file is too large to preview. Open it in your vault editor." }), { status: 413 })));
  await act(async () => root.render(createElement(VaultBrowser, { tree: [file], initialSelected: file.path, orgId: "fixture", workspaceLabel: "Fixture" })));
  expect(host.textContent).toContain("This file is too large to preview. Open it in your vault editor.");
  expect(host.querySelector("pre")).toBeNull();
});
test("a successful complete preview preserves legitimate file text", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ body: "Complete current rules.\r\n " }), { status: 200 })));
  await act(async () => root.render(createElement(VaultBrowser, { tree: [file], initialSelected: file.path, orgId: "fixture", workspaceLabel: "Fixture" })));
  expect(host.querySelector("pre")?.textContent).toBe("Complete current rules.\r\n ");
});
test("the resolved workspace label is displayed without a hardcoded tenant", async () => {
  await act(async () => root.render(createElement(VaultBrowser, { tree: [], initialSelected: "", orgId: "fixture", workspaceLabel: "Current workspace" })));
  expect(host.textContent).toContain("Current workspace"); expect(host.textContent).not.toContain("fixture-workspace");
});

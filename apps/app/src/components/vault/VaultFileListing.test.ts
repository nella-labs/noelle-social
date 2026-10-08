import http from "node:http";
import https from "node:https";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { VaultFileListing, type VaultFileListingState } from "./VaultFileListing";

vi.mock("@/components/nav/AppLink", () => ({ AppLink: (props: Record<string, unknown>) => createElement("a", props) }));
vi.mock("@/components/vault/VaultBrowser", () => ({ VaultBrowser: ({ workspaceLabel, orgId, initialSelected }: {
  workspaceLabel: string; orgId: string; initialSelected: string;
}) => createElement("aside", { "data-org": orgId, "data-selected": initialSelected }, workspaceLabel) }));
const empty = { files: [], partial: false, nextPageToken: null };
function render(state: VaultFileListingState, pageToken?: string) {
  return renderToStaticMarkup(createElement(VaultFileListing, { state,
    tree: [{ type: "file", name: "rules.md", path: "rules.md", lastModifiedISO: "2026-10-05T00:00:00Z" }],
    initialSelected: "rules.md", orgId: "fixture-org", orgSlug: "fixture", workspaceLabel: "Current workspace",
    ...(pageToken === undefined ? {} : { pageToken }),
  }));
}
beforeEach(() => {
  vi.spyOn(http, "request").mockImplementation(() => { throw new Error("HTTP forbidden in listing view tests"); });
  vi.spyOn(https, "request").mockImplementation(() => { throw new Error("HTTPS forbidden in listing view tests"); });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Fetch forbidden in listing view tests"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("a partial available page keeps its notice, workspace and preview selection", () => {
  const html = render({ status: "ready", source: "local", files: [{ path: "fixture/rules.md", size: 12, updatedISO: "2026-10-05T00:00:00Z" }], partial: true, nextPageToken: "local1:50" });
  expect(html).toContain('role="status"'); expect(html).toContain("Partial local scan");
  expect(html).toContain('data-org="fixture-org"'); expect(html).toContain('data-selected="rules.md"');
  expect(html).toContain("Current workspace"); expect(html).toContain("pageToken=local1%3A50");
});
test("an empty cloud continuation displays current-page state and encoded navigation", () => {
  const html = render({ status: "ready", source: "cloud", ...empty, nextPageToken: "cloud1:provider+/next=" }, "cloud1:first");
  expect(html).toContain("No files on this page.");
  expect(html).toContain('aria-label="Vault file pages"'); expect(html).toContain("First page"); expect(html).toContain("Next page");
  expect(html).toContain("pageToken=cloud1%3Aprovider%2B%2Fnext%3D"); expect(html).toContain("btn btn-sm btn-ghost");
  expect(html).not.toContain("<aside");
});
test("a partial-empty local scan does not claim a confirmed empty vault", () => {
  const html = render({ status: "ready", source: "local", ...empty, partial: true });
  expect(html).toContain("does not establish that the vault is empty"); expect(html).not.toContain("No markdown files found");
});
test.each(["local", "cloud"] as const)("a complete first empty page names its %s source", source => {
  const html = render({ status: "ready", source, ...empty });
  expect(html).toContain(source === "local" ? "No markdown files found in the local vault" : "No files found in the cloud vault");
  expect(html).not.toContain('aria-label="Vault file pages"');
});
test.each([{ status: "invalid_page" }, { status: "unavailable", source: "cloud", ...empty, message: "Could not load this vault listing. Try again." }] satisfies VaultFileListingState[])("$status gives an alert and restart without file controls", state => {
  const html = render(state, "cloud1:old");
  expect(html).toContain('role="alert"'); expect(html).toContain('href="/app/fixture/vault"'); expect(html).toContain("First page");
  expect(html).not.toContain("<aside"); expect(html).not.toContain('aria-label="Vault file pages"');
});
test("an unprovisioned result links to configuration rather than an empty source", () => {
  const html = render({ status: "unprovisioned", source: null, ...empty });
  expect(html).toContain("no longer provisioned"); expect(html).toContain('href="/app/fixture/settings"');
  expect(html).not.toContain("No files found");
});

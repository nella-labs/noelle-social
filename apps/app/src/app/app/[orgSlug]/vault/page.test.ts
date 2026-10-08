import { createElement } from "react";
import http from "node:http";
import https from "node:https";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ usage: [] as unknown[], listing: { status: "ready", source: "local", files: [], partial: false, nextPageToken: null } as import("@/lib/vault").VaultListingPage,
  invalid: false, vault: true,
  Error: class extends Error { constructor(readonly code: string) { super("Start from the first page."); } },
}));
vi.mock("@/lib/queries", () => ({ getOrgBySlug: async () => ({ id: "fixture-org" }) }));
vi.mock("@/lib/vault", () => ({
  getVaultForOrg: async () => fixture.vault ? { status: "active", storage_prefix: "fixture/", nella_workspace_id: "Fixture" } : null,
  listAnchorUsageForOrg: async () => fixture.usage,
  listVaultFilesForOrg: async () => { if (fixture.invalid) throw new fixture.Error("invalid_page"); return fixture.listing; },
  VaultListingError: fixture.Error,
}));
vi.mock("@/components/nav/AppLink", () => ({ AppLink: (props: Record<string, unknown>) => createElement("a", props) }));
vi.mock("@/components/nav/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("@/components/vault/VaultBrowser", () => ({ VaultBrowser: ({ workspaceLabel }: { workspaceLabel: string }) => createElement("aside", null, workspaceLabel) }));
beforeEach(() => { fixture.usage = []; fixture.invalid = false; fixture.vault = true;
  vi.spyOn(http, "request").mockImplementation(() => { throw new Error("HTTP forbidden in page tests"); });
  vi.spyOn(https, "request").mockImplementation(() => { throw new Error("HTTPS forbidden in page tests"); });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Fetch forbidden in page tests"); }));
  fixture.listing = { status: "ready", source: "local", files: [], partial: false, nextPageToken: null };
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function page(pageToken?: string) {
  const { default: VaultPage } = await import("./page");
  return renderToStaticMarkup(await VaultPage({ params: Promise.resolve({ orgSlug: "fixture" }), searchParams: Promise.resolve(pageToken === undefined ? {} : { pageToken }) }));
}
test("a live vault with no recorded usage shows zero drafts instead of historical fixtures", async () => {
  const html = await page();
  expect(html).toContain("0 drafts");
});
test("a partial local page labels only its captured metadata and supplies continuation", async () => {
  fixture.listing = { status: "ready", source: "local", files: [{ path: "fixture/rules.md", size: 12, updatedISO: "2026-10-05T00:00:00Z" }], partial: true, nextPageToken: "local1:50" };
  const html = await page();
  expect(html).toContain("Partial local scan"); expect(html).toContain("Files on this page"); expect(html).toContain("Folders on this page");
  expect(html).toContain("pageToken=local1%3A50"); expect(html).toContain("Next page"); expect(html).toContain("Fixture");
  expect(html).not.toContain("synced ·"); expect(html).not.toContain("Last synced");
});
test("newest listed modification time compares actual instants instead of ISO text", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-05T03:00:00Z"));
  fixture.listing.files = [{ path: "fixture/old.md", size: 1, updatedISO: "2026-10-05T09:00:00+12:00" }, { path: "fixture/new.md", size: 1, updatedISO: "2026-10-05T01:00:00Z" }];
  const html = await page();
  expect(html).toContain("Newest listed file"); expect(html).toContain("2h"); expect(html).not.toContain("Last synced");
});
test("a confirmed local empty result names the local source", async () => {
  const html = await page(); expect(html).toContain("No markdown files found in the local vault"); expect(html).not.toContain("empty in cloud storage");
});
test("an empty cloud page with continuation does not claim an empty vault", async () => {
  fixture.listing = { status: "ready", source: "cloud", files: [], partial: false, nextPageToken: "cloud1:provider+/next=" };
  const html = await page("cloud1:first");
  expect(html).toContain("No files on this page"); expect(html).toContain("Next page"); expect(html).toContain("First page");
  expect(html).toContain("pageToken=cloud1%3Aprovider%2B%2Fnext%3D");
});
test("partial-empty and unavailable results are distinct from a confirmed empty vault", async () => {
  fixture.listing.partial = true;
  expect(await page()).toContain("The partial scan found no files to display");
  fixture.listing = { status: "unavailable", source: "cloud", files: [], partial: false, nextPageToken: null, message: "Could not load this vault listing. Try again." };
  const html = await page();
  expect(html).toContain("Could not load this vault listing"); expect(html).not.toContain("No files on this page"); expect(html).toContain("—");
});
test("an invalid cursor can restart and unprovisioned vaults link to voice setup", async () => {
  fixture.invalid = true;
  expect(await page("local1:50")).toContain("First page");
  fixture.vault = false;
  const html = await page();
  expect(html).toContain("Set up your voice");
  expect(html).toContain('href="/app/fixture/onboarding/vault"');
});
test("real recent usage is shown without calling historical entries today's activity", async () => {
  fixture.usage = [{ draft_id: "real-draft", agent_role: "x_intern", created_at: "2020-01-01T00:00:00Z", anchor_paths: ["real.md"] }];
  const html = await page();
  expect(html).toContain("real.md");
  expect(html).toContain("1 drafts");
  expect(html).toContain("Recent anchor usage");
  expect(html).not.toContain("Anchors used today");
});

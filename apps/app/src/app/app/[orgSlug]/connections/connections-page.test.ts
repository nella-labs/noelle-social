// @vitest-environment jsdom

import { cloneElement, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const redirectError = new Error("NEXT_REDIRECT");
const navMocks = vi.hoisted(() => ({
  redirect: vi.fn(() => {
    throw redirectError;
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

const queryMocks = vi.hoisted(() => ({
  getOrgBySlug: vi.fn(),
  getOrgSpendByBucketRange: vi.fn(),
  getOrgBudgetCapCents: vi.fn(),
  getOrgSpendByWorkerRange: vi.fn(),
  getOrgSpendTrendRange: vi.fn(),
  getApifyProviderSpend: vi.fn(),
  loadXApiSpend: vi.fn(),
  listConnectionStatuses: vi.fn(),
  listApifyConnections: vi.fn(),
  getApifySpendByToken: vi.fn(),
  getXApiConnection: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: navMocks.redirect,
  notFound: navMocks.notFound,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children, ...props }: { href: string; children: ReactNode }) =>
      React.createElement("a", { href, ...props }, children),
  };
});

vi.mock("@/lib/queries", () => ({
  getOrgBySlug: queryMocks.getOrgBySlug,
  getOrgSpendByBucketRange: queryMocks.getOrgSpendByBucketRange,
  getOrgBudgetCapCents: queryMocks.getOrgBudgetCapCents,
  getOrgSpendByWorkerRange: queryMocks.getOrgSpendByWorkerRange,
  getOrgSpendTrendRange: queryMocks.getOrgSpendTrendRange,
  getApifyProviderSpend: queryMocks.getApifyProviderSpend,
  loadXApiSpend: queryMocks.loadXApiSpend,
  listApifyConnections: queryMocks.listApifyConnections,
  getApifySpendByToken: queryMocks.getApifySpendByToken,
  getXApiConnection: queryMocks.getXApiConnection,
  isApifyBucket: (bucket: string | null | undefined) => bucket?.startsWith("apify") ?? false,
  resolveSpendRange: (key?: string) => {
    const ranges = {
      month: { key: "month", label: "September to date", startIso: "2026-09-01T00:00:00.000Z", granularity: "day" },
      quarter: { key: "quarter", label: "This quarter", startIso: "2026-07-01T00:00:00.000Z", granularity: "day" },
      year: { key: "year", label: "This year", startIso: "2026-01-01T00:00:00.000Z", granularity: "month" },
      all: { key: "all", label: "All time", startIso: "2000-01-01T00:00:00.000Z", granularity: "month" },
    } as const;
    return ranges[(key as keyof typeof ranges) || "month"] ?? ranges.month;
  },
}));

vi.mock("@/lib/connections", () => ({ listConnectionStatuses: queryMocks.listConnectionStatuses }));

vi.mock("./ApifyConnectionCard", async () => {
  const { createElement } = await import("react");
  return { ApifyConnectionCard: () => createElement("article", null, "Apify connection card") };
});

vi.mock("./XApiConnectionCard", async () => {
  const { createElement } = await import("react");
  return { XApiConnectionCard: () => createElement("article", null, "X API connection card") };
});

import ConnectionsPage from "./page";
import { SpendPanel } from "./SpendPanel";
import SpendPage from "../spend/page";

async function resolveServerTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServerTree));
  if (!isValidElement(node)) return node;

  if (typeof node.type === "function") {
    const rendered = await (node.type as (props: unknown) => ReactNode | Promise<ReactNode>)(node.props);
    return resolveServerTree(rendered);
  }

  const props = node.props as { children?: ReactNode };
  if (!("children" in props)) return node;
  return cloneElement(node, undefined, await resolveServerTree(props.children));
}

async function renderNode(node: ReactNode): Promise<Document> {
  const html = renderToStaticMarkup(await resolveServerTree(node));
  document.body.innerHTML = html;
  return document;
}

function pageProps(searchParams: { tab?: string; range?: string }) {
  return {
    params: Promise.resolve({ orgSlug: "operator" }),
    searchParams: Promise.resolve(searchParams),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";

  queryMocks.getOrgBySlug.mockResolvedValue({ id: "org_1", name: "Operator" });
  queryMocks.listConnectionStatuses.mockResolvedValue([
    { kind: "gemini", status: "connected", preview: "AIza...", lastUpdatedAt: null, errorMessage: null, source: "org" },
  ]);
  queryMocks.listApifyConnections.mockResolvedValue([]);
  queryMocks.getApifySpendByToken.mockResolvedValue([]);
  queryMocks.getXApiConnection.mockResolvedValue({ hasVega: true, connected: false, handle: null });

  queryMocks.getOrgSpendByBucketRange.mockResolvedValue([
    { bucket: "drafter-codex", cents: 1234 },
    { bucket: "apify-discovery", cents: 500 },
  ]);
  queryMocks.getOrgBudgetCapCents.mockResolvedValue(10000);
  queryMocks.getOrgSpendByWorkerRange.mockResolvedValue([
    { worker: "drafter", llmCents: 1234, apifyCents: 0 },
    { worker: "discovery", llmCents: 0, apifyCents: 500 },
  ]);
  queryMocks.getOrgSpendTrendRange.mockResolvedValue([{ day: "2026-09-01", llmCents: 1234, apifyCents: 500 }]);
  queryMocks.getApifyProviderSpend.mockResolvedValue({
    cents: 500, unverifiedCents: 0, fetchedAt: "2026-09-17T12:00:00.000Z",
    byDay: [{ day: "2026-09-01", cents: 500 }],
  });
  queryMocks.loadXApiSpend.mockResolvedValue({ tier: "basic", monthlyCostCents: 20000, postsThisMonth: 2, repliesThisMonth: 3 });
});

describe("ConnectionsPage", () => {
  it("defaults to the connections tab", async () => {
    const doc = await renderNode(await ConnectionsPage(pageProps({})));

    expect(doc.querySelector('a[href="/app/operator/connections"]')?.getAttribute("aria-current")).toBe("page");
    expect(Array.from(doc.querySelectorAll("h2"), (heading) => heading.textContent)).toEqual([
      "Data sources", "X posting",
    ]);
    expect(doc.body.textContent).toContain("Apify connection card");
    expect(doc.body.textContent).toContain("X API connection card");
    expect(queryMocks.listConnectionStatuses).not.toHaveBeenCalled();
    expect(queryMocks.getOrgSpendByBucketRange).not.toHaveBeenCalled();
  });

  it("renders the spend report without loading connection data", async () => {
    const doc = await renderNode(await ConnectionsPage(pageProps({ tab: "spend", range: "quarter" })));

    expect(doc.querySelector('a[href="/app/operator/connections?tab=spend"]')?.getAttribute("aria-current")).toBe("page");
    expect(doc.body.textContent).toContain("This quarter");
    expect(doc.body.textContent).toContain("$12.34");
    expect(queryMocks.getOrgSpendByBucketRange).toHaveBeenCalledWith("org_1", "2026-07-01T00:00:00.000Z");
    expect(queryMocks.listConnectionStatuses).not.toHaveBeenCalled();
    expect(queryMocks.listApifyConnections).not.toHaveBeenCalled();
    expect(queryMocks.getXApiConnection).not.toHaveBeenCalled();
  });
});

describe("SpendPanel", () => {
  it("keeps range tabs on the merged connections route", async () => {
    const doc = await renderNode(createElement(SpendPanel, { orgId: "org_1", orgSlug: "operator", rangeParam: "quarter" }));
    const tabs = Array.from(doc.querySelectorAll<HTMLAnchorElement>('[role="tab"]'));

    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute("href")])).toEqual([
      ["Month", "/app/operator/connections?tab=spend"],
      ["Quarter", "/app/operator/connections?tab=spend&range=quarter"],
      ["Year", "/app/operator/connections?tab=spend&range=year"],
      ["All time", "/app/operator/connections?tab=spend&range=all"],
    ]);
  });
  it("uses provider Apify spend as the actual total and keeps uncovered ledger spend separate", async () => {
    queryMocks.getApifyProviderSpend.mockResolvedValue({
      cents: 250,
      unverifiedCents: 175,
      fetchedAt: "2026-09-17T12:00:00.000Z",
      byDay: [{ day: "2026-09-01", cents: 250 }],
    });

    const doc = await renderNode(
      createElement(SpendPanel, { orgId: "org_1", orgSlug: "operator", rangeParam: "month" }),
    );
    const text = doc.body.textContent ?? "";

    expect(queryMocks.getApifyProviderSpend).toHaveBeenCalledWith(
      "org_1",
      "2026-09-01T00:00:00.000Z",
    );
    expect(text).toContain("Apify provider usage");
    expect(text).toContain("$2.50");
    expect(text).toContain("$1.75");
    expect(text).toContain("unverified");
    expect(text).not.toContain("$5.00");
  });

  it("charts provider Apify daily buckets and leaves worker totals LLM-only", async () => {
    queryMocks.getApifyProviderSpend.mockResolvedValue({
      cents: 250,
      unverifiedCents: 0,
      fetchedAt: "2026-09-17T12:00:00.000Z",
      byDay: [{ day: "2026-09-01", cents: 250 }],
    });

    const doc = await renderNode(
      createElement(SpendPanel, { orgId: "org_1", orgSlug: "operator", rangeParam: "month" }),
    );
    const text = doc.body.textContent ?? "";

    expect(text).toContain("2026-09-01: 12.34 LLM · 2.50 Apify");
    expect(text).not.toContain("2026-09-01: 12.34 LLM · 5.00 Apify");
    expect(text).toContain("Drafter");
    expect(text).not.toContain("Discovery");
    expect(text).not.toContain("$12.34 LLM · $5.00 Apify");
  });

  it("charts provider-only Apify dates that have no local ledger row", async () => {
    queryMocks.getOrgSpendTrendRange.mockResolvedValue([
      { day: "2026-09-01", llmCents: 1234, apifyCents: 500 },
    ]);
    queryMocks.getApifyProviderSpend.mockResolvedValue({
      cents: 400,
      unverifiedCents: 0,
      fetchedAt: "2026-09-17T12:00:00.000Z",
      byDay: [{ day: "2026-09-02", cents: 400 }],
    });

    const doc = await renderNode(
      createElement(SpendPanel, { orgId: "org_1", orgSlug: "operator", rangeParam: "month" }),
    );
    const text = doc.body.textContent ?? "";

    expect(text).toContain("2026-09-01: 12.34 LLM · 0.00 Apify");
    expect(text).toContain("2026-09-02: 0.00 LLM · 4.00 Apify");
    expect(text).toContain("Apify · $4.00");
    expect(text).not.toContain("2026-09-01: 12.34 LLM · 5.00 Apify");
  });

  it("does not show a fake zero-dollar provider amount before the first fetch", async () => {
    queryMocks.getApifyProviderSpend.mockResolvedValue({
      cents: 0,
      unverifiedCents: 0,
      fetchedAt: null,
      byDay: [],
    });

    const doc = await renderNode(
      createElement(SpendPanel, { orgId: "org_1", orgSlug: "operator", rangeParam: "month" }),
    );
    const text = doc.body.textContent ?? "";

    expect(text).toContain("Not fetched");
    expect(text).not.toContain("$0.00");
  });

  it("shows a genuine zero-dollar provider balance after a fetch", async () => {
    queryMocks.getApifyProviderSpend.mockResolvedValue({
      cents: 0,
      unverifiedCents: 0,
      fetchedAt: "2026-09-17T12:00:00.000Z",
      byDay: [],
    });

    const doc = await renderNode(
      createElement(SpendPanel, { orgId: "org_1", orgSlug: "operator", rangeParam: "month" }),
    );
    const text = doc.body.textContent ?? "";

    expect(text).toContain("Apify provider usage");
    expect(text).toContain("$0.00");
    expect(text).toContain("Last fetched Sep 17, 12:00 PM UTC");
  });
});

describe("legacy spend route", () => {
  it("redirects to the merged spend tab and preserves range", async () => {
    await expect(
      SpendPage({
        params: Promise.resolve({ orgSlug: "operator" }),
        searchParams: Promise.resolve({ range: "year" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(navMocks.redirect).toHaveBeenCalledWith("/app/operator/connections?tab=spend&range=year");
  });
});

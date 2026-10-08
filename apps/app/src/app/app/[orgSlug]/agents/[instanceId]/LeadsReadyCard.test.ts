/**
 * Regression: the Leads-ready card's "Review & reply" button must open the
 * SINGLE highest-priority pending lead (the top of the approvals queue), not
 * dump the operator on the whole-queue list. The bug shipped a hardcoded list
 * href with no approval id, so clicking it showed every lead instead of the one
 * to action next.
 *
 * Pure-markup test: LeadsReadyCard is a server component that renders straight
 * from props, so we SSR it with renderToStaticMarkup and read the button's
 * href out of the markup. The card links via our AppLink wrapper (which calls
 * useRouter and would need a router under bare SSR); we stub it to a plain
 * anchor so the href is trivial to assert.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("@/components/nav/AppLink", () => ({
  AppLink: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    createElement("a", { href, ...rest }, children as never),
}));

import { LeadsReadyCard } from "./LeadsReadyCard";
import type { PipelineSnapshot } from "@/lib/queries";

const baseSnapshot: PipelineSnapshot = {
  status: "active",
  pipelineStartedAt: "2026-05-30T18:00:00.000Z",
  leadsReady: 3,
  leadsReadyLastRun: null,
  lastRunStartedAt: null,
  goal: { target: null, startedAt: null, produced: 0, ready: 0 },
  discoveryConfig: null,
  schedule: null,
  workers: [],
};

// LeadsReadyCard renders exactly one <Link>, so the first href in the markup is
// the Review button's target.
function reviewHrefOf(markup: string): string | null {
  const m = markup.match(/href="([^"]*)"/);
  return m ? m[1] : null;
}

test("Review button deep-links to the specific next lead when one is pending", () => {
  const approvalId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const html = renderToStaticMarkup(
    createElement(LeadsReadyCard, {
      orgSlug: "acme",
      snapshot: baseSnapshot,
      nextApprovalHref: `/app/acme/approvals/${approvalId}`,
    }),
  );
  expect(reviewHrefOf(html)).toBe(`/app/acme/approvals/${approvalId}`);
});

test("Review button falls back to the queue when nothing is pending", () => {
  const html = renderToStaticMarkup(
    createElement(LeadsReadyCard, {
      orgSlug: "acme",
      snapshot: { ...baseSnapshot, leadsReady: 0 },
      nextApprovalHref: null,
    }),
  );
  expect(reviewHrefOf(html)).toBe("/app/acme/approvals");
});

test("Review button falls back to the queue when no href prop is supplied", () => {
  const html = renderToStaticMarkup(
    createElement(LeadsReadyCard, { orgSlug: "acme", snapshot: baseSnapshot }),
  );
  expect(reviewHrefOf(html)).toBe("/app/acme/approvals");
});

test("headline is scoped to the last run (not the cumulative pending count)", () => {
  const html = renderToStaticMarkup(
    createElement(LeadsReadyCard, {
      orgSlug: "acme",
      // 12 leads pending overall, but only 1 from the most recent run.
      snapshot: {
        ...baseSnapshot,
        leadsReady: 12,
        leadsReadyLastRun: 1,
        lastRunStartedAt: "2026-06-08T00:00:00.000Z",
      },
      nextApprovalHref: null,
    }),
  );
  // Shows the last-run count, tagged "last run" — not the cumulative 12.
  expect(html).toContain(">1<");
  expect(html).not.toContain(">12<");
  expect(html).toContain("last run");
});

test("falls back to cumulative count when the instance never ran a goal", () => {
  const html = renderToStaticMarkup(
    createElement(LeadsReadyCard, {
      orgSlug: "acme",
      snapshot: { ...baseSnapshot, leadsReady: 7, leadsReadyLastRun: null },
      nextApprovalHref: null,
    }),
  );
  expect(html).toContain(">7<");
  expect(html).not.toContain("last run");
});

// Lyra (LinkedIn intern) reuses this card but her fallback must land on her own
// draft-only inbox stream, not the org-wide X queue. The card takes an optional
// approvalsListHref for exactly this.
test("Review button falls back to the supplied stream href (LinkedIn intern)", () => {
  const html = renderToStaticMarkup(
    createElement(LeadsReadyCard, {
      orgSlug: "acme",
      snapshot: { ...baseSnapshot, leadsReady: 0 },
      nextApprovalHref: null,
      approvalsListHref: "/app/acme/approvals?stream=linkedin-intern",
    }),
  );
  expect(reviewHrefOf(html)).toBe("/app/acme/approvals?stream=linkedin-intern");
});

test("a specific next lead still wins over the supplied stream fallback", () => {
  const approvalId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const html = renderToStaticMarkup(
    createElement(LeadsReadyCard, {
      orgSlug: "acme",
      snapshot: baseSnapshot,
      nextApprovalHref: `/app/acme/approvals/${approvalId}`,
      approvalsListHref: "/app/acme/approvals?stream=linkedin-intern",
    }),
  );
  expect(reviewHrefOf(html)).toBe(`/app/acme/approvals/${approvalId}`);
});

// Vega keeps the default org-wide queue fallback when no override is passed.
test("Review button defaults to the org queue when no stream href is supplied", () => {
  const html = renderToStaticMarkup(
    createElement(LeadsReadyCard, {
      orgSlug: "acme",
      snapshot: { ...baseSnapshot, leadsReady: 0 },
      nextApprovalHref: null,
    }),
  );
  expect(reviewHrefOf(html)).toBe("/app/acme/approvals");
});

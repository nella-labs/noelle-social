// @vitest-environment jsdom

/**
 * Regression test for the Vega agent page going completely dead — every
 * button and link non-interactive, breadcrumb stuck on the raw UUID.
 *
 * Root cause: VegaSendQueuePanel computed time-relative strings (Date.now(),
 * relative "Xs ago", and timezone-dependent toLocaleTimeString) DURING RENDER.
 * The server renders one value and the client computes a different one when it
 * hydrates, so React aborts hydration of the route segment. Once hydration
 * aborts, the App Router never finishes mounting the page: onClick handlers
 * never attach, <Link> clicks get preventDefaulted into a dead router, and the
 * SetCrumb effect never runs (so the breadcrumb shows the UUID, not "Vega").
 *
 * This test SSRs the panel at one instant, then hydrates a few seconds later
 * (the real server/client time skew) and asserts React reports NO recoverable
 * hydration error. It fails before the fix and passes after.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act } from "react";
import { VegaSendQueuePanel } from "./VegaSendQueuePanel";
import type { AutoSendQueueRow, SentApprovalRow } from "@/lib/queries";

const queue: AutoSendQueueRow[] = [
  {
    approvalId: "11111111-1111-1111-1111-111111111111",
    targetAt: "2026-05-30T18:30:00.000Z",
    authorHandle: "patio11",
    charCount: 142,
    bodyPreview: "queued reply preview",
  } as AutoSendQueueRow,
];

const sent: SentApprovalRow[] = [
  {
    approvalId: "22222222-2222-2222-2222-222222222222",
    postedAt: "2026-05-30T18:00:00.000Z",
    decidedAt: "2026-05-30T18:00:00.000Z",
    authorHandle: "patio11",
    charCount: 130,
    bodyPreview: "sent reply preview",
    autoSent: true,
    sendMethod: "auto",
    postUrl: "https://x.com/x/status/1",
  } as SentApprovalRow,
];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("VegaSendQueuePanel hydrates without a mismatch across server/client time skew", async () => {
  // Server renders at T0.
  vi.setSystemTime(new Date("2026-05-30T18:29:15.000Z"));
  const element = createElement(VegaSendQueuePanel, {
    queue,
    sent,
    autoSendEnabled: true,
    configHref: "/app/operator/agents/x/config",
  });
  const ssrHtml = renderToString(element);

  const container = document.createElement("div");
  container.innerHTML = ssrHtml;
  document.body.appendChild(container);

  // The client hydrates a few seconds later — exactly the skew that exists
  // between the server render and the browser picking it up.
  vi.setSystemTime(new Date("2026-05-30T18:29:21.000Z"));

  const recoverableErrors: unknown[] = [];
  await act(async () => {
    hydrateRoot(container, element, {
      onRecoverableError: (err) => recoverableErrors.push(err),
    });
  });

  const messages = recoverableErrors.map((e) =>
    e instanceof Error ? e.message : String(e),
  );
  const hydrationErrors = messages.filter((m) => /hydrat/i.test(m));

  expect(
    hydrationErrors,
    `Hydration mismatch(es): ${hydrationErrors.join(" | ")}`,
  ).toHaveLength(0);
});

test("autopilot readouts (status + caps + next-send) hydrate without a mismatch", async () => {
  // Server renders at T0 with the autopilot panel on: the master-switch prop is
  // supplied and a usage snapshot is present. The next-send readout is
  // time-relative, so this guards that it (like the queue rows) defers all
  // clock-dependent output past mount and doesn't diverge across skew.
  vi.setSystemTime(new Date("2026-05-30T18:29:15.000Z"));
  const element = createElement(VegaSendQueuePanel, {
    queue,
    sent,
    autoSendEnabled: true,
    configHref: "/app/operator/agents/x/config",
    // NOELLE_AUTOPILOT_PANEL-on shape: armed autopilot, master switch off (the
    // amber "Armed — master OFF" state) + a real caps snapshot.
    replySendEnabled: false,
    usage: { per30Min: 2, perDay: 11, per30MinCap: 6, perDayCap: 50 },
  });
  const ssrHtml = renderToString(element);

  const container = document.createElement("div");
  container.innerHTML = ssrHtml;
  document.body.appendChild(container);

  vi.setSystemTime(new Date("2026-05-30T18:29:21.000Z"));

  const recoverableErrors: unknown[] = [];
  await act(async () => {
    hydrateRoot(container, element, {
      onRecoverableError: (err) => recoverableErrors.push(err),
    });
  });

  const messages = recoverableErrors.map((e) =>
    e instanceof Error ? e.message : String(e),
  );
  const hydrationErrors = messages.filter((m) => /hydrat/i.test(m));

  expect(
    hydrationErrors,
    `Hydration mismatch(es): ${hydrationErrors.join(" | ")}`,
  ).toHaveLength(0);
});

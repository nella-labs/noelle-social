// @vitest-environment jsdom

/**
 * Regression test for the Vega agent page going completely dead — every button
 * and link non-interactive — caused by a hydration mismatch.
 *
 * PipelinePanel is the page's other live-ticking client component (alongside
 * VegaSendQueuePanel): it renders relative "Nm ago" timers and lead counts. If
 * any of those were computed from `Date.now()` / `toLocaleString` DURING RENDER,
 * the server HTML and the first client render would disagree and React would
 * abort hydration of the whole route segment — onClick handlers never attach,
 * <Link> clicks fall back to dead client routing, and the page is frozen until a
 * full reload. The panel guards against this by keeping `now` null until mounted
 * (rel() returns "—") and using a deterministic thousands separator instead of
 * toLocaleString().
 *
 * This test SSRs the panel at one instant, then hydrates a few seconds later
 * (the real server→client time skew) and asserts React reports NO recoverable
 * hydration error. It locks the fix in: re-introduce a render-time clock and
 * this goes red.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act } from "react";

// PipelinePanel pulls in the Next router and the server actions module; neither
// is exercised by hydration, so stub them so the component renders standalone.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
}));
vi.mock("./actions", () => ({
  startAll: vi.fn(async () => ({ ok: true })),
  stopAll: vi.fn(async () => ({ ok: true })),
  setWorkerEnabled: vi.fn(async () => ({ ok: true })),
}));

import { PipelinePanel } from "./PipelinePanel";
import type { PipelineSnapshot } from "@/lib/queries";

// A goal-run, mid-flight, with workers in the states that render relative time
// (`runningSince`, `lastFinishedAt`) — the exact fields that would mismatch if
// the timers were computed at render scope.
const snapshot: PipelineSnapshot = {
  status: "active",
  pipelineStartedAt: "2026-05-30T18:00:00.000Z",
  leadsReady: 7,
  goal: {
    target: 20,
    startedAt: "2026-05-30T18:00:00.000Z",
    produced: 12,
    ready: 7,
  },
  workers: [
    {
      kind: "discovery",
      enabled: true,
      toggleable: true,
      runsWhilePaused: false,
      state: "running",
      lifetime: 1234,
      today: 56,
      sinceStart: 12,
      lastFinishedAt: "2026-05-30T18:25:00.000Z",
      runningSince: "2026-05-30T18:29:00.000Z",
    },
    {
      kind: "classifier",
      enabled: true,
      toggleable: true,
      runsWhilePaused: false,
      state: "idle",
      lifetime: 9876,
      today: 120,
      sinceStart: 30,
      lastFinishedAt: "2026-05-30T18:20:00.000Z",
      runningSince: null,
    },
    {
      kind: "profiler",
      enabled: true,
      toggleable: true,
      runsWhilePaused: true,
      state: "idle",
      lifetime: 4,
      today: 1,
      sinceStart: 0,
      lastFinishedAt: null,
      runningSince: null,
    },
  ],
} as PipelineSnapshot;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("PipelinePanel hydrates without a mismatch across server/client time skew", async () => {
  // Server renders at T0.
  vi.setSystemTime(new Date("2026-05-30T18:29:15.000Z"));
  const element = createElement(PipelinePanel, {
    orgSlug: "operator",
    instanceId: "11111111-1111-1111-1111-111111111111",
    snapshot,
    agentRole: "x_intern" as const,
  });
  const ssrHtml = renderToString(element);

  const container = document.createElement("div");
  container.innerHTML = ssrHtml;
  document.body.appendChild(container);

  // The client hydrates a few seconds later — the skew between the server render
  // and the browser picking it up. A render-time clock would diverge here.
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

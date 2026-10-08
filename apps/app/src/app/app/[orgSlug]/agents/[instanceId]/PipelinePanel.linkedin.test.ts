/**
 * The pipeline panel is shared by Vega (x_intern) and Lyra (linkedin_intern).
 * Lyra is DRAFT-ONLY — she never posts to LinkedIn — so her snapshot omits the
 * 'send' worker and the funnel renders four stages (Discovery, Classifier,
 * Drafter, Profiler) plus the always-on Watchlist lane. This test renders the
 * panel from a LinkedIn snapshot and asserts NO "Send" row ever appears (and the
 * four funnel stages + the Watchlist lane do).
 *
 * It also pins the inverse for Vega: a snapshot that DOES carry a 'send' worker
 * still renders the Send row — so excluding it for Lyra never regresses Vega.
 *
 * Server-render only (renderToStaticMarkup): the panel renders straight from the
 * snapshot prop, so the funnel rows are present in the SSR markup without needing
 * a client mount. next/navigation + the server actions module are stubbed so the
 * client component renders standalone.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

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
import type { PipelineSnapshot, PipelineWorkerSnapshot } from "@/lib/queries";

function worker(
  kind: PipelineWorkerSnapshot["kind"],
  over: Partial<PipelineWorkerSnapshot> = {},
): PipelineWorkerSnapshot {
  return {
    kind,
    enabled: true,
    toggleable: true,
    runsWhilePaused: kind === "profiler",
    state: "idle",
    lifetime: 1,
    today: 0,
    sinceStart: 0,
    lastFinishedAt: null,
    runningSince: null,
    lastError: null,
    ...over,
  };
}

const linkedinSnapshot: PipelineSnapshot = {
  status: "active",
  pipelineStartedAt: "2026-06-08T18:00:00.000Z",
  leadsReady: 2,
  leadsReadyLastRun: null,
  lastRunStartedAt: null,
  goal: { target: null, startedAt: null, produced: 0, ready: 2 },
  // This funnel fixture leaves tailoring off (null hides the form). The LinkedIn
  // tailored-run fields are exercised in PipelinePanel.tailor.test.ts.
  discoveryConfig: null,
  schedule: null,
  // The four draft-only funnel stages — NO 'send' — plus the always-on Watchlist
  // lane (getLinkedInPipelineSnapshot pushes it after the four LINKEDIN_WORKERS,
  // runsWhilePaused so it keeps working while the pipeline is paused).
  workers: [
    worker("discovery"),
    worker("classifier"),
    worker("drafter"),
    worker("profiler"),
    worker("watchlist", { runsWhilePaused: true }),
  ],
};

test("LinkedIn funnel renders the four draft-only stages + Watchlist, and NO Send row", () => {
  const html = renderToStaticMarkup(
    createElement(PipelinePanel, {
      orgSlug: "operator",
      instanceId: "22222222-2222-2222-2222-222222222222",
      snapshot: linkedinSnapshot,
      agentRole: "linkedin_intern",
    }),
  );
  expect(html).toContain("Discovery");
  expect(html).toContain("Classifier");
  expect(html).toContain("Drafter");
  expect(html).toContain("Profiler");
  // The always-on Watchlist lane renders for Lyra (mirrors Vega).
  expect(html).toContain("Watchlist");
  // The Send stage label must never appear for Lyra.
  expect(html).not.toContain(">Send<");
  expect(html).not.toContain("sent</span>");
});

test("Watchlist lane still renders for Lyra while the pipeline is paused", () => {
  const html = renderToStaticMarkup(
    createElement(PipelinePanel, {
      orgSlug: "operator",
      instanceId: "22222222-2222-2222-2222-222222222222",
      // Paused funnel, but the always-on Watchlist lane is enabled — it must keep
      // showing (runsWhilePaused) so the operator can see/toggle it while paused.
      snapshot: {
        ...linkedinSnapshot,
        status: "paused",
        workers: [
          worker("discovery", { state: "disabled" }),
          worker("classifier", { state: "disabled" }),
          worker("drafter", { state: "disabled" }),
          worker("profiler", { runsWhilePaused: true }),
          worker("watchlist", { runsWhilePaused: true, enabled: true }),
        ],
      },
      agentRole: "linkedin_intern",
    }),
  );
  expect(html).toContain("Watchlist");
  expect(html).not.toContain(">Send<");
});

test("Vega funnel still renders the Send row when the snapshot carries it", () => {
  const html = renderToStaticMarkup(
    createElement(PipelinePanel, {
      orgSlug: "operator",
      instanceId: "11111111-1111-1111-1111-111111111111",
      snapshot: {
        ...linkedinSnapshot,
        workers: [
          worker("discovery"),
          worker("classifier"),
          worker("drafter"),
          worker("send"),
          worker("profiler"),
        ],
      },
      agentRole: "x_intern",
    }),
  );
  expect(html).toContain(">Send<");
});

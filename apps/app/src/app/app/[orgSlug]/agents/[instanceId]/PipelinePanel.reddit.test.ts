/**
 * The pipeline panel is shared by Vega (x_intern), Lyra (linkedin_intern), and
 * Orion (reddit_intern). Orion has no send WORKER (the actuator posts) and,
 * unlike the other two, NO profiler and NO priority-people watchlist lane — its
 * watchlist is *subreddits*, which is just its discovery source. So Orion's
 * snapshot renders exactly three worker stages (Discovery, Classifier, Drafter),
 * and pausing it sleeps the WHOLE pipeline (there is no always-on lane to keep alive).
 *
 * This pins the paused-state copy: it must describe Orion sleeping entirely and
 * must NOT carry Lyra's "Profiler keeps building their profiles / watched people"
 * language (the bug that made the panel claim Orion kept drafting while paused).
 *
 * Server-render only (renderToStaticMarkup): next/navigation + the server actions
 * module are stubbed so the client component renders standalone.
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
    runsWhilePaused: false,
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

// Orion's funnel: three stages only — no Send, no Profiler, no Watchlist lane.
const redditSnapshot: PipelineSnapshot = {
  status: "paused",
  pipelineStartedAt: "2026-06-20T09:00:00.000Z",
  leadsReady: 0,
  leadsReadyLastRun: null,
  lastRunStartedAt: null,
  goal: { target: null, startedAt: null, produced: 0, ready: 0 },
  discoveryConfig: null,
  schedule: null,
  workers: [
    worker("discovery", { state: "disabled" }),
    worker("classifier", { state: "disabled" }),
    worker("drafter", { state: "disabled" }),
  ],
};

test("Orion renders only the three worker stages — no Profiler, Watchlist, or Send row", () => {
  const html = renderToStaticMarkup(
    createElement(PipelinePanel, {
      orgSlug: "operator",
      instanceId: "5a81bc63-4fad-42a1-a50c-e67ba1ae3a1d",
      snapshot: { ...redditSnapshot, status: "active" },
      agentRole: "reddit_intern",
    }),
  );
  expect(html).toContain("Discovery");
  expect(html).toContain("Classifier");
  expect(html).toContain("Drafter");
  expect(html).not.toContain("Profiler");
  expect(html).not.toContain(">Send<");
});

test("paused Orion says the whole pipeline is asleep — NOT Lyra's profiler/watched-people copy", () => {
  const html = renderToStaticMarkup(
    createElement(PipelinePanel, {
      orgSlug: "operator",
      instanceId: "5a81bc63-4fad-42a1-a50c-e67ba1ae3a1d",
      snapshot: redditSnapshot,
      agentRole: "reddit_intern",
    }),
  );
  // Orion's paused copy: the whole pipeline sleeps, anchored on the subreddit lane.
  expect(html).toContain("Orion is asleep");
  expect(html).toContain("subreddit watchlist");
  // The Lyra-inherited copy must never appear for Orion.
  expect(html).not.toContain("Profiler keeps building");
  expect(html).not.toContain("watched people");
});

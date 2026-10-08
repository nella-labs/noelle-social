/**
 * The pipeline panel is shared by Vega (x_intern) and Lyra (linkedin_intern) but
 * its copy + tailored-run controls are agent-specific (from agent-ui-config). This
 * pins the agent-aware bits in the SSR markup:
 *   - the goal-run noun ("…replies + DMs ready" for Vega vs "…drafts ready" for Lyra)
 *   - the drafter's role line (Vega posts; Lyra never sends)
 *   - that the "Tailor this run" affordance now appears for Lyra (real discoveryConfig)
 *
 * The individual tailor FIELDS live behind a collapsible (closed in SSR), so the
 * exact field set is asserted in agent-ui-config.test.ts; here we prove the panel
 * surfaces the right copy + offers the tailored run at all.
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
  };
}

// Goal inactive (target null) so the "Get me N …" form + Tailor toggle render;
// discoveryConfig present so the tailored run is offered.
function snapshot(workers: PipelineWorkerSnapshot["kind"][]): PipelineSnapshot {
  return {
    status: "active",
    pipelineStartedAt: null,
    leadsReady: 0,
    leadsReadyLastRun: null,
    lastRunStartedAt: null,
    goal: { target: null, startedAt: null, produced: 0, ready: 0 },
    discoveryConfig: {},
    schedule: null,
    workers: workers.map(worker),
  };
}

test("Lyra renders draft-only copy + offers the tailored run", () => {
  const html = renderToStaticMarkup(
    createElement(PipelinePanel, {
      orgSlug: "operator",
      instanceId: "22222222-2222-2222-2222-222222222222",
      snapshot: snapshot(["discovery", "classifier", "drafter", "profiler"]),
      agentRole: "linkedin_intern",
    }),
  );
  expect(html).toContain("posts with reply drafts ready");
  expect(html).toContain("drafts the reply (never sends)");
  expect(html).toContain("Tailor this run");
  // Vega's copy must not leak onto Lyra.
  expect(html).not.toContain("leads with replies + DMs ready");
  expect(html).not.toContain("posts approved replies to X");
});

test("Vega keeps its post-everything copy", () => {
  const html = renderToStaticMarkup(
    createElement(PipelinePanel, {
      orgSlug: "operator",
      instanceId: "11111111-1111-1111-1111-111111111111",
      snapshot: snapshot(["discovery", "classifier", "drafter", "send", "profiler"]),
      agentRole: "x_intern",
    }),
  );
  expect(html).toContain("leads with replies + DMs ready");
  expect(html).toContain("generates the replies + DMs");
  expect(html).toContain("posts approved replies to X");
  expect(html).not.toContain("connections with reply + DM drafts ready");
});

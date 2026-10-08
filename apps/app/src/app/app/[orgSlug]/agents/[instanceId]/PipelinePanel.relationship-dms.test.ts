// @vitest-environment jsdom

import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineSnapshot, PipelineWorkerSnapshot } from "@/lib/queries";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({
  startAll: vi.fn(async () => ({ ok: true })),
  stopAll: vi.fn(async () => ({ ok: true })),
  setWorkerEnabled: vi.fn(async () => ({ ok: true })),
  setRelationshipDmsEnabled: vi.fn(async () => ({ ok: true })),
}));

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
  startAll: actions.startAll,
  stopAll: actions.stopAll,
  setWorkerEnabled: actions.setWorkerEnabled,
  setRelationshipDmsEnabled: actions.setRelationshipDmsEnabled,
}));

import { PipelinePanel } from "./PipelinePanel";

function worker(
  kind: PipelineWorkerSnapshot["kind"],
  over: Partial<PipelineWorkerSnapshot> = {},
): PipelineWorkerSnapshot {
  return {
    kind,
    enabled: true,
    toggleable: true,
    runsWhilePaused: kind === "profiler" || kind === "watchlist",
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

function snapshot(status: "active" | "paused"): PipelineSnapshot {
  return {
    status,
    pipelineStartedAt: null,
    leadsReady: 3,
    leadsReadyLastRun: null,
    lastRunStartedAt: null,
    goal: { target: null, startedAt: null, produced: 0, ready: 3 },
    discoveryConfig: {},
    schedule: null,
    workers: [
      worker("discovery", { state: status === "paused" ? "disabled" : "idle" }),
      worker("classifier", { state: status === "paused" ? "disabled" : "idle" }),
      worker("drafter", { state: status === "paused" ? "disabled" : "idle" }),
      worker("profiler"),
      worker("watchlist"),
    ],
  };
}

describe("PipelinePanel relationship DMs", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        clear: () => store.clear(),
      },
      configurable: true,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    actions.startAll.mockClear();
    actions.stopAll.mockClear();
    actions.setWorkerEnabled.mockClear();
    actions.setRelationshipDmsEnabled.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("lets paused Lyra toggle Friendly DMs without starting the reply pipeline", async () => {
    await act(async () => {
      root.render(
        createElement(PipelinePanel, {
          orgSlug: "operator",
          instanceId: "22222222-2222-2222-2222-222222222222",
          snapshot: snapshot("paused"),
          agentRole: "linkedin_intern",
          relationshipDms: {
            platform: "linkedin",
            enabled: false,
            approvalsHref: "/app/operator/approvals?kind=dm_request&stream=linkedin-intern",
          },
        }),
      );
    });

    expect(container.textContent).toContain("Friendly DMs");
    expect(container.textContent).toContain("40/day");
    expect(container.textContent).toContain("saved person context");
    expect(container.textContent).toContain("Review required");
    expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toContain(
      "/app/operator/approvals?kind=dm_request&stream=linkedin-intern",
    );
    const reviewLink = Array.from(container.querySelectorAll("a")).find(
      (link) => link.textContent?.includes("Review Friendly DMs"),
    );
    await act(async () => reviewLink?.click());
    expect(window.localStorage.getItem("noelle.showDms")).toBe("1");

    const toggle = container.querySelector<HTMLInputElement>(
      'input[aria-label="Friendly DMs"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.disabled).toBe(false);

    await act(async () => {
      toggle?.click();
    });

    expect(actions.setRelationshipDmsEnabled).toHaveBeenCalledWith({
      orgSlug: "operator",
      instanceId: "22222222-2222-2222-2222-222222222222",
      enabled: true,
    });
    expect(actions.startAll).not.toHaveBeenCalled();
    expect(actions.stopAll).not.toHaveBeenCalled();
    expect(actions.setWorkerEnabled).not.toHaveBeenCalled();
  });

  it("keeps a successful optimistic save on while waiting for refreshed props", async () => {
    let resolveSave!: (value: { ok: true }) => void;
    actions.setRelationshipDmsEnabled.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );

    await act(async () => {
      root.render(
        createElement(PipelinePanel, {
          orgSlug: "operator",
          instanceId: "22222222-2222-2222-2222-222222222222",
          snapshot: snapshot("paused"),
          agentRole: "linkedin_intern",
          relationshipDms: {
            platform: "linkedin",
            enabled: false,
            approvalsHref: "/app/operator/approvals?stream=linkedin-intern",
          },
        }),
      );
    });

    const toggle = container.querySelector<HTMLInputElement>(
      'input[aria-label="Friendly DMs"]',
    )!;

    await act(async () => {
      toggle.click();
    });
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);

    await act(async () => {
      resolveSave({ ok: true });
    });

    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
  });

  it("disables while saving and rolls back when the save fails", async () => {
    let resolveSave!: (value: {
      ok: false;
      error: { code: string; message: string };
    }) => void;
    actions.setRelationshipDmsEnabled.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );

    await act(async () => {
      root.render(
        createElement(PipelinePanel, {
          orgSlug: "operator",
          instanceId: "22222222-2222-2222-2222-222222222222",
          snapshot: snapshot("paused"),
          agentRole: "linkedin_intern",
          relationshipDms: {
            platform: "linkedin",
            enabled: false,
            approvalsHref: "/app/operator/approvals?stream=linkedin-intern",
          },
        }),
      );
    });

    const toggle = container.querySelector<HTMLInputElement>(
      'input[aria-label="Friendly DMs"]',
    )!;

    await act(async () => {
      toggle.click();
    });
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);

    await act(async () => {
      resolveSave({
        ok: false,
        error: { code: "bad_save", message: "Could not save DMs" },
      });
    });

    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
    expect(container.textContent).toContain("Could not save DMs");
  });

  it("renders the X cap and never renders Friendly DMs for Orion", async () => {
    await act(async () => {
      root.render(
        createElement(PipelinePanel, {
          orgSlug: "operator",
          instanceId: "11111111-1111-1111-1111-111111111111",
          snapshot: snapshot("active"),
          agentRole: "x_intern",
          relationshipDms: {
            platform: "x",
            enabled: true,
            approvalsHref: "/app/operator/approvals?kind=dm_request&stream=x-intern",
          },
        }),
      );
    });

    expect(container.textContent).toContain("Friendly DMs");
    expect(container.textContent).toContain("15/day");

    await act(async () => {
      root.render(
        createElement(PipelinePanel, {
          orgSlug: "operator",
          instanceId: "5a81bc63-4fad-42a1-a50c-e67ba1ae3a1d",
          snapshot: {
            ...snapshot("paused"),
            workers: [
              worker("discovery", { state: "disabled", runsWhilePaused: false }),
              worker("classifier", { state: "disabled", runsWhilePaused: false }),
              worker("drafter", { state: "disabled", runsWhilePaused: false }),
            ],
          },
          agentRole: "reddit_intern",
        }),
      );
    });

    expect(container.textContent).not.toContain("Friendly DMs");
  });
});

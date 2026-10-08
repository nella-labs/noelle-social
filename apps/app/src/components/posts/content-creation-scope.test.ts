// @vitest-environment jsdom
import http from "node:http";
import https from "node:https";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const f = vi.hoisted(() => ({
  org: vi.fn(),
  instance: vi.fn(),
  api: vi.fn(),
  revalidate: vi.fn(),
  compose: vi.fn(),
}));
vi.mock("@/lib/queries", () => ({ getOrgBySlug: f.org }));
vi.mock("@/lib/schedule-queries", () => ({ getInstanceIdForRole: f.instance }));
vi.mock("@/lib/posts-queries", () => ({ getPostThread: vi.fn() }));
vi.mock("@/lib/with-rate-limit", () => ({
  withRateLimit: (_name: string, _opts: unknown, callback: unknown) => callback,
}));
vi.mock("@/lib/api", () => ({ noelleFetch: f.api, NoelleApiError: class extends Error {} }));
vi.mock("next/cache", () => ({ revalidatePath: f.revalidate }));
vi.mock("@/components/nav/AppLink", () => ({
  AppLink: ({ children, ...props }: { children: import("react").ReactNode }) =>
    createElement("a", props, children),
}));
vi.mock("@/app/app/[orgSlug]/content/schedule-actions", () => ({
  createComposeJobAction: f.compose,
}));
const orgId = "11111111-1111-4111-8111-111111111111",
  instanceId = "22222222-2222-4222-8222-222222222222",
  ideaId = "33333333-3333-4333-8333-333333333333";
let root: Root | undefined, host: HTMLDivElement | undefined;
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  f.org.mockReset().mockResolvedValue({ id: orgId });
  f.instance.mockReset().mockResolvedValue(instanceId);
  f.revalidate.mockReset();
  f.api
    .mockReset()
    .mockResolvedValue({ enqueued: true, mode: "single", batch_id: null, idea_id: ideaId });
  f.compose.mockReset().mockResolvedValue({ items_total: 1 });
  for (const network of [http, https])
    for (const method of ["request", "get"] as const)
      vi.spyOn(network, method).mockImplementation(() => {
        throw new Error("Network forbidden in content caller proof");
      });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Fetch forbidden in content caller proof");
    }),
  );
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test("actual Compose form retains its already-resolved instance in review-mode requests", async () => {
  const { ComposeForm } = await import("@/components/posts/ComposeForm");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      createElement(ComposeForm, {
        orgSlug: "selected",
        instanceId,
        platform: "x",
        canAutoPost: true,
        laneColor: "var(--accent)",
        today: "2026-10-06",
      }),
    ),
  );
  const button = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Generate"),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(f.api.mock.calls[0]?.[1]?.body).toMatchObject({
    orgId,
    agentInstanceId: instanceId,
    platform: "x",
  });
  expect(f.compose).not.toHaveBeenCalled();
});

test.each(["x", "linkedin", null] as const)(
  "actual weekly planner retains lane %s when requesting a batch",
  async (platform) => {
    const { ContentWeekPlanner } = await import("@/components/posts/ContentWeekPlanner");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        createElement(ContentWeekPlanner, {
          orgSlug: "selected",
          drafts: [],
          today: "2026-10-06",
          platform,
        }),
      ),
    );
    const button = host.querySelector("button");
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(f.api.mock.calls[0]?.[1]?.body).toMatchObject({
      mode: "batch",
      platform: platform ?? undefined,
    });
  },
);
test("actual view-only Reddit weekly planner cannot queue LinkedIn ideation", async () => {
  const { ContentWeekPlanner } = await import("@/components/posts/ContentWeekPlanner");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      createElement(ContentWeekPlanner, {
        orgSlug: "selected",
        drafts: [],
        today: "2026-10-06",
        platform: "reddit",
      }),
    ),
  );
  const button = host.querySelector("button");
  if (button) await act(async () => button.click());
  expect(f.api).not.toHaveBeenCalled();
});

test.each(["x", "linkedin", "reddit", "video"] as const)(
  "missing %s channel surfaces point to the working setup destination",
  async (platform) => {
    f.instance.mockResolvedValue(null);
    const { configForPlatform } = await import("@/lib/agent-content-config");
    const { channelForRole } = await import("@/lib/social-channels");
    const panels = [
      (await import("./ComposePanel")).ComposePanel,
      (await import("./TrendingBoard")).TrendingBoard,
      (await import("./PerformancePanel")).PerformancePanel,
      (await import("./VoiceProfile")).VoiceProfile,
    ];
    const lane = configForPlatform(platform);
    const label = channelForRole(lane.role!)!.label;
    for (const Panel of panels) {
      const html = renderToStaticMarkup(await Panel({ lane, orgSlug: "selected" }));
      expect(html).toContain("/app/selected/settings?tab=channels");
      expect(html).toContain(`Set up ${label}`);
      expect(html).not.toMatch(/org-chart|isn’t hired|Hire /);
    }
    expect(f.api).not.toHaveBeenCalled();
    expect(f.compose).not.toHaveBeenCalled();
  },
);

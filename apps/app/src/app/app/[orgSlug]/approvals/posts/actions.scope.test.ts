import http from "node:http";
import https from "node:https";
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
vi.mock("@/app/app/[orgSlug]/content/schedule-actions", () => ({
  createComposeJobAction: f.compose,
}));
import { triggerIdeation, addManualIdea } from "@/app/app/[orgSlug]/approvals/posts/actions";
const orgId = "11111111-1111-4111-8111-111111111111",
  instanceId = "22222222-2222-4222-8222-222222222222",
  ideaId = "33333333-3333-4333-8333-333333333333";
beforeEach(() => {
  f.org.mockReset().mockResolvedValue({ id: orgId });
  f.instance.mockReset().mockResolvedValue(instanceId);
  f.revalidate.mockReset();
  for (const network of [http, https])
    for (const method of ["request", "get"] as const)
      vi.spyOn(network, method).mockImplementation(() => {
        throw new Error("Network forbidden in content action tests");
      });
  vi.stubGlobal("fetch", () => {
    throw new Error("Fetch forbidden in content action tests");
  });
  f.api
    .mockReset()
    .mockResolvedValue({ enqueued: true, mode: "single", batch_id: null, idea_id: ideaId });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test("actual ideate action forwards the authenticated selected organization", async () => {
  expect((await triggerIdeation({ orgSlug: "selected", platform: "x", mode: "single" })).ok).toBe(
    true,
  );
  expect(f.org).toHaveBeenCalledWith("selected");
  expect(f.api.mock.calls[0]?.[1]?.body).toMatchObject({ orgId, platform: "x" });
});
test("actual manual action forwards the authenticated selected organization", async () => {
  expect(
    (await addManualIdea({ orgSlug: "selected", platform: "linkedin", hook: "Current brief" })).ok,
  ).toBe(true);
  expect(f.org).toHaveBeenCalledWith("selected");
  expect(f.api.mock.calls[0]?.[1]?.body).toMatchObject({ orgId, platform: "linkedin" });
});
test.each(["ideate", "manual"])(
  "missing selected organization blocks %s before API dispatch",
  async (kind) => {
    f.org.mockResolvedValue(null);
    const result =
      kind === "ideate"
        ? await triggerIdeation({ orgSlug: "missing", mode: "single" })
        : await addManualIdea({ orgSlug: "missing", hook: "Current brief" });
    expect(result.ok).toBe(false);
    expect(f.api).not.toHaveBeenCalled();
    expect(f.revalidate).not.toHaveBeenCalled();
  },
);
test("healthy lane and manual text survive the current action wire", async () => {
  await addManualIdea({
    orgSlug: "selected",
    platform: "x",
    hook: "  Operator text  ",
    targetPlatforms: ["x"],
  });
  expect(f.api).toHaveBeenCalledWith(
    "/api/posts/manual",
    expect.objectContaining({
      body: expect.objectContaining({
        hook: "Operator text",
        platform: "x",
        targetPlatforms: ["x"],
      }),
    }),
  );
  expect(f.revalidate).toHaveBeenCalledWith("/app/selected/content");
});
test("schema-invalid count blocks actual ideation before API dispatch", async () => {
  await expect(
    triggerIdeation({ orgSlug: "selected", platform: "x", mode: "single", count: 99 }),
  ).rejects.toThrow();
  expect(f.api).not.toHaveBeenCalled();
});

test.each(["ideate", "manual"])(
  "missing selected lane blocks %s without fallback or revalidation",
  async (kind) => {
    f.instance.mockResolvedValue(null);
    const result =
      kind === "ideate"
        ? await triggerIdeation({ orgSlug: "selected", platform: "x", mode: "single" })
        : await addManualIdea({ orgSlug: "selected", platform: "x", hook: "Operator brief" });
    expect(result.ok).toBe(false);
    expect(f.api).not.toHaveBeenCalled();
    expect(f.revalidate).not.toHaveBeenCalled();
  },
);
test("All lane selects LinkedIn within the authenticated selected organization", async () => {
  await triggerIdeation({ orgSlug: "selected", mode: "batch" });
  expect(f.instance).toHaveBeenCalledWith(orgId, "linkedin_intern");
  expect(f.api.mock.calls[0]?.[1]?.body).toMatchObject({
    orgId,
    agentInstanceId: instanceId,
    mode: "batch",
  });
});
test("explicit stale instance is rejected before content dispatch", async () => {
  const result = await triggerIdeation({
    orgSlug: "selected",
    platform: "x",
    mode: "single",
    instanceId: "44444444-4444-4444-8444-444444444444",
  });
  expect(result.ok).toBe(false);
  expect(f.api).not.toHaveBeenCalled();
  expect(f.revalidate).not.toHaveBeenCalled();
});
test("an explicit matching UUID is accepted independent of case", async () => {
  const current = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  f.instance.mockResolvedValue(current);
  expect(
    (
      await triggerIdeation({
        orgSlug: "selected",
        platform: "x",
        mode: "single",
        instanceId: current.toUpperCase(),
      })
    ).ok,
  ).toBe(true);
  expect(f.api.mock.calls[0]?.[1]?.body).toMatchObject({ agentInstanceId: current });
});

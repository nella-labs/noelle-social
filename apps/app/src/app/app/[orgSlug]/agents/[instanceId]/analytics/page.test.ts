import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { OwnAccountAnalytics, OwnPostRow } from "@/lib/video-analytics-queries";
const data = vi.hoisted(() => ({ analytics: undefined as unknown as OwnAccountAnalytics }));
vi.mock("@/lib/queries", () => ({ getOrgBySlug: async () => ({ id: "org" }),
  listAgentInstancesForOrg: async () => [{ id: "instance", role: "video_intern" }] }));
vi.mock("@/lib/video-analytics-queries", () => ({ getOwnAccountAnalytics: async () => data.analytics, listLinkableDrafts: async () => [] }));
vi.mock("./PostAttribution", () => ({ PostAttribution: () => null }));
import Page from "./page";
const post = (id: string, views: number | null): OwnPostRow => ({ id, externalId: id, caption: `Clip ${id}`,
  url: "https://example.test/clip", thumbUrl: null, views, likes: 0, comments: null, shares: null, saves: null,
  followerCount: null, reachMultiple: null, postedAt: null, viewsGained: null, draftId: null, draftHook: null, qualityScore: null });
beforeEach(() => { data.analytics = { handle: "example", platform: "instagram", trackingHandle: "example", followerCount: null, followerDelta: null, followerSeries: [], posts: [] }; });
async function render() {
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ orgSlug: "sample-org", instanceId: "instance" }) }));
}
it("labels a partial view sum with its measurement coverage", async () => {
  data.analytics.posts = [post("unknown", null), post("zero", 0), post("known", 5)];
  const html = await render();
  expect(html).toContain("Measured views"); expect(html).toContain("2/3 posts measured");
  expect(html).not.toContain("Total views"); expect(html).toContain("unknown");
});
it("shows unknown when no post has measured views", async () => {
  data.analytics.posts = [post("unknown", null)];
  const html = await render();
  expect(html).toContain("0/1 posts measured"); expect(html).toContain("unknown");
});
it("retains a complete zero total and avoids unsafe aggregate sums", async () => {
  data.analytics.posts = [post("zero", 0)];
  expect(await render()).toContain("Total views");
  data.analytics.posts = [post("first", Number.MAX_SAFE_INTEGER), post("second", Number.MAX_SAFE_INTEGER)];
  expect(await render()).toContain("unknown");
});
it("names the selected platform and uses complete-history delta instead of the truncated series", async () => {
  data.analytics.posts = [post("known", 1)];
  data.analytics.platform = "tiktok";
  data.analytics.followerCount = 749; data.analytics.followerDelta = 749;
  data.analytics.followerSeries = [{ capturedAt: "2026-06-03T08:00:00Z", followerCount: 30 }];
  const html = await render();
  expect(html).toContain("@example · TikTok"); expect(html).toContain("+749 tracked");
  expect(html).not.toContain("+719 tracked"); expect(html).toContain("Follower change covers all measured captures for this account.");
});
it("does not report a growth delta for one measured capture", async () => {
  data.analytics.posts = [post("known", 1)]; data.analytics.followerCount = 0;
  data.analytics.followerSeries = [{ capturedAt: "2026-06-03T08:00:00Z", followerCount: 0 }];
  expect(await render()).not.toContain("+0 tracked");
});

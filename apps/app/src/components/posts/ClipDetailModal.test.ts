// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { VideoClipRow } from "@/lib/video-queries";
const action = vi.hoisted(() => ({ load: vi.fn(async () => ({ ok: false })) }));
vi.mock("@/app/app/[orgSlug]/agents/[instanceId]/video-watchlist-actions", () => ({ loadVideoClipDetail: action.load }));
import { ClipDetailModal } from "./ClipDetailModal";
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ""; vi.clearAllMocks(); });
it("renders unknown and zero counters, and keeps Escape and Close interactions", async () => {
  const clip: VideoClipRow = { id: "clip", platform: "instagram", external_id: "clip", source_kind: "creator",
    author_handle: "example", caption: "Saved clip", url: "https://example.test/clip", thumb_url: null,
    views: null, likes: 0, comments: null, author_follower_count: 100, deep_tier: false, posted_at: null };
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const close = vi.fn();
  await act(async () => root!.render(createElement(ClipDetailModal, { clip, orgSlug: "sample-org", instanceId: "instance", onClose: close })));
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  expect(host.textContent).toContain("unknownviews"); expect(host.textContent).toContain("0likes");
  expect(host.textContent).toContain("unknowncomments"); expect(host.textContent).not.toContain("views/followers");
  expect(action.load).toHaveBeenCalledWith({ orgSlug: "sample-org", instanceId: "instance", clipId: "clip" });
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(close).toHaveBeenCalledTimes(1);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
  expect(close).toHaveBeenCalledTimes(2);
});

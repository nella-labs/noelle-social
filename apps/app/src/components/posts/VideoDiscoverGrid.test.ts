// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VideoClipRow } from "@/lib/video-queries";
vi.mock("@/app/app/[orgSlug]/agents/[instanceId]/watchlist/ClipThumb", () => ({ ClipThumb: () => null }));
vi.mock("./ClipDetailModal", () => ({ ClipDetailModal: ({ clip, onClose }: { clip: VideoClipRow; onClose: () => void }) =>
  createElement("dialog", { open: true }, clip.caption, createElement("button", { onClick: onClose }, "Close")) }));
import { VideoDiscoverGrid } from "./VideoDiscoverGrid";

const clip = (id: string, views: number | null, likes: number | null): VideoClipRow => ({
  id, platform: "instagram", external_id: id, author_handle: id, caption: `Clip ${id}`,
  url: `https://example.test/${id}`, thumb_url: null, source_kind: "creator", views, likes,
  comments: null, author_follower_count: 100, deep_tier: false, posted_at: null,
});
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ""; });
async function render() {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(createElement(VideoDiscoverGrid, {
    orgSlug: "sample-org", instanceId: "sample-instance",
    clips: [clip("unknown", null, null), clip("zero", 0, 0), clip("measured", 200, 10)],
  })));
}
function cards() { return [...host.querySelectorAll<HTMLButtonElement>("button.card")]; }
async function click(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label)!;
  expect(button).toBeDefined(); await act(async () => button.click()); return button;
}

describe("Video discovery measured metrics", () => {
  it("sorts measured views and likes ahead of unknown, retaining zero", async () => {
    await render();
    expect(cards().map(c => c.textContent?.match(/@(unknown|zero|measured)/)?.[1])).toEqual(["measured", "zero", "unknown"]);
    expect(cards()[2]!.textContent).toContain("unknown");
    await click("Likes");
    expect(cards().map(c => c.textContent?.match(/@(unknown|zero|measured)/)?.[1])).toEqual(["measured", "zero", "unknown"]);
    expect(cards()[1]!.textContent).toContain("♥ 0");
  });

  it("uses numeric ratio filters and preserves their selected interaction state", async () => {
    await render(); const filter = await click("Views/followers ≥1×");
    expect(filter.getAttribute("aria-pressed")).toBe("true");
    expect(cards()).toHaveLength(1); expect(cards()[0]!.textContent).toContain("@measured");
    expect(host.textContent).not.toMatch(/outran audience|audience-fed/i);
    await click("All ratios"); expect(cards()).toHaveLength(3);
  });

  it("opens and closes the same clip detail after sorting", async () => {
    await render(); await act(async () => cards()[1]!.click());
    expect(host.querySelector("dialog")?.textContent).toContain("Clip zero");
    await click("Close"); expect(host.querySelector("dialog")).toBeNull();
  });
});

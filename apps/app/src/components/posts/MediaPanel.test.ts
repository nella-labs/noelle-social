import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ContentMediaRow } from "@/lib/posts-queries";
vi.mock("@/app/app/[orgSlug]/approvals/posts/actions", () => ({ uploadMedia: vi.fn(), deleteMedia: vi.fn() }));
import { MediaPanel } from "./MediaPanel";

const media: ContentMediaRow = { id: "fixture", kind: "video", platform: null, mime_type: "video/mp4", url: "https://fixture.invalid/clip.mp4",
  width: null, height: null, duration_ms: null, bytes: 5, idea_id: null, draft_id: null, caption: "Sample clip", status: "ready", created_at: "2026-10-06T00:00:00Z" };
function render(status: string) { return renderToStaticMarkup(createElement(MediaPanel, { orgSlug: "one", media: [{ ...media, status }] })); }

describe("media cleanup state", () => {
  it("shows a retry for pending deletion without playing or copying unavailable bytes", () => {
    const html = render("deleting");
    expect(html).toContain("Retry delete"); expect(html).toContain("Deletion pending");
    expect(html).not.toContain("<video"); expect(html).not.toContain("Copy path");
  });
  it("shows a missing current link as unavailable without playback or copy controls", () => {
    const html = renderToStaticMarkup(createElement(MediaPanel, { orgSlug: "one", media: [{ ...media, url: null }] }));
    expect(html).toContain("File unavailable"); expect(html).not.toContain("<video"); expect(html).not.toContain("Copy path");
  });
  it("keeps ready video playback and copy controls", () => {
    const html = render("ready"); expect(html).toContain("<video"); expect(html).toContain("Copy path");
  });
});

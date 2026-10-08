import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import type { PostDraftRow, PostIdeaRow } from "@/lib/posts-queries";

vi.mock("@/app/app/[orgSlug]/approvals/posts/actions", () => ({
  markReadyPost: vi.fn(), dismissPost: vi.fn(), markPostedPost: vi.fn(),
  patchPostDraft: vi.fn(), schedulePostIdea: vi.fn(), uploadMedia: vi.fn(),
  deleteMedia: vi.fn(), loadPostThread: vi.fn(),
}));
vi.mock("./VideoDraftsStudio", () => ({ VideoDraftsStudio: () => null }));
vi.mock("./InspirationRefs", () => ({ InspirationRefs: () => null }));
vi.mock("./DrafterChat", () => ({ DrafterChat: () => null }));
vi.mock("./StylePicker", () => ({ StylePicker: () => null }));
import { DraftsPanel } from "./DraftsPanel";

const idea: PostIdeaRow = {
  id: "idea-a", platform: "linkedin", target_platforms: ["linkedin"],
  pending_platforms: null, hook: "A useful idea", thesis: null, angle: null,
  pillar: null, inspiration_refs: [], suggested_day: null, batch_id: null,
  status: "approved", created_at: "2025-01-01",
};
const draft: PostDraftRow = {
  id: "draft-a", idea_id: idea.id, platform: "linkedin", body: "A useful post.",
  final_body: null, char_count: 14, posted_url: null, draft_hook: null,
  cta: null, notes: null, category: null, stage: "draft", quality_score: null,
  quality_passed: null, verifier_meta: null, status: "draft", created_at: "2025-01-01",
  hook: idea.hook, suggested_day: null, inspiration_refs: [],
};

test.each(["approved", "drafting"] as const)(
  "legacy %s ideas without live job evidence do not claim active generation",
  (status) => {
    const html = renderToStaticMarkup(createElement(DraftsPanel, {
      orgSlug: "workspace", today: "2026-10-08", drafts: [],
      generating: [{ ...idea, status }],
    }));
    expect(html).toContain("Draft pending");
    expect(html).toContain(idea.hook);
    expect(html).not.toContain("Generating");
  },
);

test("an unconfigured LinkedIn preview shows a neutral profile", () => {
  const html = renderToStaticMarkup(createElement(DraftsPanel, {
    orgSlug: "workspace", today: "2026-10-08", drafts: [draft],
  }));
  expect(html).toContain("Your profile");
  expect(html).not.toContain("Founder");
  expect(html).not.toContain("Noelle");
});

test("a configured preview retains its supplied profile name", () => {
  const html = renderToStaticMarkup(createElement(DraftsPanel, {
    orgSlug: "workspace", today: "2026-10-08", drafts: [draft],
    userName: "Configured profile",
  }));
  expect(html).toContain("Configured profile");
  expect(html).not.toContain("Founder");
});

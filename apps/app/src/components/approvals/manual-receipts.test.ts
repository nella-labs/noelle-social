// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PostDraftRow } from "@/lib/posts-queries";
import type { SpeedrunDraft } from "./SpeedrunRow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  replySave: vi.fn(),
  markSent: vi.fn(),
  postSave: vi.fn(),
  markReady: vi.fn(),
  markPosted: vi.fn(),
  router: { push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => fixture.router, usePathname: () => "/fixture" }));
vi.mock("@/app/app/[orgSlug]/approvals/actions", () => ({
  saveDraftEdit: fixture.replySave, markSentManual: fixture.markSent,
  sendDraft: vi.fn(), skipDraft: vi.fn(), unmarkSentManual: vi.fn(),
}));
vi.mock("@/app/app/[orgSlug]/approvals/posts/actions", () => ({
  patchPostDraft: fixture.postSave, markReadyPost: fixture.markReady, markPostedPost: fixture.markPosted,
  dismissPost: vi.fn(), schedulePostIdea: vi.fn(), uploadMedia: vi.fn(), deleteMedia: vi.fn(),
  loadPostThread: vi.fn(async () => ({ ok: true, notes: [], media: [] })),
}));
vi.mock("./VipFlagBanner", () => ({ VipFlagBanner: () => null }));
vi.mock("./DraftDmButton", () => ({ DraftDmButton: () => null }));
vi.mock("@/components/posts/VideoDraftsStudio", () => ({ VideoDraftsStudio: () => null }));
vi.mock("@/components/posts/DrafterChat", () => ({ DrafterChat: () => null }));
vi.mock("@/components/posts/StylePicker", () => ({ StylePicker: () => null }));

import { SpeedrunRow } from "./SpeedrunRow";
import { DraftReviewPanel } from "./DraftReviewPanel";
import { CopyButton } from "./CopyButton";
import { DeferredDmActions } from "@/components/contacts/DeferredDmActions";
import { DraftsPanel } from "@/components/posts/DraftsPanel";

const draft: PostDraftRow = {
  id: "post-draft", idea_id: "post-idea", platform: "x", body: "A specific post.", final_body: null,
  char_count: null, posted_url: null, draft_hook: "A specific post.", cta: null, notes: null,
  category: null, stage: "written", quality_score: null, quality_passed: null, verifier_meta: null,
  status: "ready", created_at: "2026-01-01T00:00:00Z", hook: "A specific post.",
  suggested_day: null, inspiration_refs: [],
};
const reply: SpeedrunDraft = {
  id: "reply-approval", kind: "reply", lead: {
    handle: "@fixture", profileUrl: null, tier: null, followers: null, postId: "123",
    recipientId: null, score: null,
  },
  sourceTweet: "Source text", pushedAt: "1h", postUrl: "https://x.com/fixture/status/123",
  angles: [{ id: "reply-angle", kind: "Technical", text: "A useful reply.", quality: null }],
};
let container: HTMLDivElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  fixture.replySave.mockResolvedValue({ ok: true });
  fixture.markSent.mockResolvedValue({ ok: true });
  fixture.postSave.mockResolvedValue({ ok: true });
  fixture.markReady.mockResolvedValue({ ok: true });
  fixture.markPosted.mockResolvedValue({ ok: true });
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Keep every source/composer link inside this local DOM fixture.
  container.addEventListener("click", (event) => event.preventDefault());
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
async function render(element: Parameters<Root["render"]>[0]) { await act(async () => root.render(element)); }
async function click(button: HTMLElement) { await act(async () => button.click()); }
function button(label: RegExp) {
  const match = Array.from(container.querySelectorAll("button")).find((b) => label.test(b.textContent?.trim() ?? ""));
  if (!match) throw new Error(`Missing button ${label}`);
  return match;
}
async function edit(value: string) {
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function renderPost(status: PostDraftRow["status"] = "ready") {
  await render(createElement(DraftsPanel, { orgSlug: "fixture", drafts: [{ ...draft, status }], today: "2026-01-01" }));
}

test.each(["x", "linkedin", "reddit"] as const)("opening a %s source copies and selects without acknowledging a send", async (platform) => {
  const onMarkSent = vi.fn(); const onPick = vi.fn();
  await render(createElement(SpeedrunRow, {
    d: reply, n: 1, pickedId: "reply-angle", onPick, onMarkSent,
    isSent: false, onSend: vi.fn(), onSkip: vi.fn(), fullReviewHref: "/fixture/review", platform,
  }));
  await click(container.querySelector<HTMLAnchorElement>(`a[href="${reply.postUrl}"]`)!);
  expect(writeText).toHaveBeenCalledWith("A useful reply.");
  expect(onPick).toHaveBeenCalledWith("reply-angle");
  expect(onMarkSent).not.toHaveBeenCalled();
  await click(button(/^Mark sent$/));
  expect(onMarkSent).toHaveBeenCalledTimes(1);
});

test("opening a deferred DM composer does not record a send; the acknowledgment still does", async () => {
  await render(createElement(DeferredDmActions, { orgSlug: "fixture", approvalId: "dm-approval", body: "A draft DM", recipientId: "123" }));
  await click(container.querySelector("a")!);
  expect(fixture.markSent).not.toHaveBeenCalled();
  await click(button(/Mark DM sent/));
  expect(fixture.markSent).toHaveBeenCalledWith({ orgSlug: "fixture", approvalId: "dm-approval" });
});

test("copying a ready original post does not record it as posted", async () => {
  await renderPost();
  await click(button(/^Copy/));
  expect(writeText).toHaveBeenCalledWith(draft.body);
  expect(fixture.markPosted).not.toHaveBeenCalled();
  await click(button(/^Mark posted$/));
  expect(fixture.markPosted).toHaveBeenCalledWith({ orgSlug: "fixture", draftId: draft.id });
});

test.each(["Save draft", "Mark ready", "Mark posted", "Copy"])("%s stops when saving an edited original post returns false", async (label) => {
  fixture.postSave.mockResolvedValue({ ok: false, error: { code: "save_failed", message: "Edit was not saved" } });
  await renderPost(label === "Mark ready" ? "draft" : "ready");
  await edit("Changed post text.");
  await click(button(new RegExp(`^${label}`)));
  expect(fixture.postSave).toHaveBeenCalled();
  expect(fixture.markReady).not.toHaveBeenCalled();
  expect(fixture.markPosted).not.toHaveBeenCalled();
  expect(writeText).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Edit was not saved");
  expect(container.textContent).not.toContain("✓ saved");
});

test("manual X reply acknowledgment waits for successful edited-body persistence", async () => {
  fixture.replySave.mockResolvedValue({ ok: false, error: { code: "save_failed", message: "Edit was not saved" } });
  await render(createElement(DraftReviewPanel, {
    orgSlug: "fixture", approvalId: "reply-approval", angles: reply.angles,
  }));
  await edit("Edited reply");
  await click(button(/^Mark sent \(manual\)$/));
  expect(fixture.replySave).toHaveBeenCalled();
  expect(fixture.markSent).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Edit was not saved");
});

test("copy feedback and callback wait for a successful clipboard write", async () => {
  let finish!: () => void;
  writeText.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const onCopied = vi.fn();
  await render(createElement(CopyButton, { text: "fixture text", onCopied }));
  await click(button(/^Copy$/));
  expect(onCopied).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("✓ Copied");
  await act(async () => finish());
  expect(onCopied).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("✓ Copied");
});

test.each(["rejected", "unavailable"])("%s clipboard never reports success", async (mode) => {
  if (mode === "rejected") writeText.mockRejectedValue(new Error("clipboard unavailable"));
  else Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  const onCopied = vi.fn();
  await render(createElement(CopyButton, { text: "fixture text", onCopied }));
  await click(button(/^Copy$/));
  expect(onCopied).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("✓ Copied");
  expect(container.textContent).toContain("Couldn't copy");
});

// @vitest-environment jsdom

import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SpeedrunDraft } from "./SpeedrunRow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({
  markSentManual: vi.fn(async () => ({ ok: true })),
  sendDraft: vi.fn(async () => ({ ok: true })),
  skipDraft: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/app/app/[orgSlug]/approvals/actions", () => actions);
vi.mock("./VipFlagBanner", () => ({ VipFlagBanner: () => null }));
vi.mock("./DraftDmButton", () => ({ DraftDmButton: () => null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { SpeedrunInbox } from "./SpeedrunInbox";

const dm: SpeedrunDraft = {
  id: "dm-card",
  kind: "dm",
  dmApprovalId: "approval-dm",
  dmText: "hiii, your launch story was hilarious",
  lead: {
    handle: "@maya",
    profileUrl: "https://x.com/maya",
    tier: null,
    followers: null,
    postId: null,
    recipientId: "123",
    score: null,
  },
  sourceTweet: "saved launch post",
  pushedAt: "1h",
  angles: [],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

test("a DM-only Speedrun card marks the DM approval sent and has no reply Send action", async () => {
  await act(async () => {
    root.render(createElement(SpeedrunInbox, {
      drafts: [dm],
      basePath: "/app/acme/approvals",
      orgSlug: "acme",
      platform: "x",
    }));
  });

  expect(container.textContent).toContain(dm.dmText);
  expect(Array.from(container.querySelectorAll("button")).some(
    (candidate) => candidate.textContent?.trim() === "Send →",
  )).toBe(false);

  await act(async () => button("Mark sent").click());
  expect(actions.markSentManual).toHaveBeenCalledWith({
    orgSlug: "acme",
    approvalId: "approval-dm",
  });
  expect(actions.sendDraft).not.toHaveBeenCalled();
});

test("a DM-only Speedrun card skips the DM approval", async () => {
  await act(async () => {
    root.render(createElement(SpeedrunInbox, {
      drafts: [dm],
      basePath: "/app/acme/approvals",
      orgSlug: "acme",
      platform: "linkedin",
    }));
  });

  await act(async () => button("Skip").click());
  expect(actions.skipDraft).toHaveBeenCalledWith({
    orgSlug: "acme",
    approvalId: "approval-dm",
  });
});

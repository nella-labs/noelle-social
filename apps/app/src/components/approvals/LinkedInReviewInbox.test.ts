// @vitest-environment jsdom

import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LinkedInApprovalView } from "@/lib/queries";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
}));

vi.mock("@/app/app/[orgSlug]/approvals/actions", () => ({
  bulkSkipDrafts: vi.fn(async () => ({ ok: true, count: 0 })),
  skipDraft: vi.fn(async () => ({ ok: true })),
  unskipDraft: vi.fn(async () => ({ ok: true })),
}));

import { LinkedInReviewInbox } from "./LinkedInReviewInbox";

function row(args: {
  id: string;
  kind: "reply" | "dm";
  body: string;
  postText?: string | null;
  postKind?: string | null;
  review?: unknown;
}): LinkedInApprovalView {
  return {
    approvalId: `ap-${args.id}`,
    status: "pending",
    createdAt: "2026-09-14T10:00:00Z",
    kind: args.kind,
    authorName: args.id,
    authorHeadline: "Builder",
    authorPublicId: args.id,
    profileUrl: `https://www.linkedin.com/in/${args.id}/`,
    postText: args.postText ?? null,
    postUrl: args.review ? `https://www.linkedin.com/feed/update/urn:li:activity:${args.id}/` : null,
    postedAt: null,
    body: args.body,
    verifierMeta: args.review,
    angle: args.kind === "dm" ? null : "empathetic",
    charCount: args.body.length,
    styleSource: null,
    postKind: args.postKind ?? null,
  };
}

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
});

test("labels pending LinkedIn replies as approved or as a queue invariant error", async () => {
  const passed = { pass: true, judgeOk: true, scores: { voice: 0.8 } };
  await act(async () => {
    root.render(createElement(LinkedInReviewInbox, {
      rows: [
        row({ id: "ready", kind: "reply", body: "ready text", postText: "ready post", review: passed }),
        row({ id: "failed", kind: "reply", body: "failed text", postText: "failed post" }),
        row({ id: "message", kind: "dm", body: "manual message", review: passed }),
      ],
      orgSlug: "acme",
      orgId: "org-1",
    }));
  });

  expect(container.textContent).toContain("Approved");
  expect(container.textContent).toContain("Queue error");
  expect(container.textContent).not.toContain("Needs quality review");
  expect(container.textContent).toContain("failed post");
  expect(container.textContent).not.toContain("manual message");
});

test("marks an unavailable policy as a queue error instead of a pending review", async () => {
  await act(async () => {
    root.render(createElement(LinkedInReviewInbox, {
      rows: [row({ id: "reviewed", kind: "reply", body: "ready text", postText: "source post",
        review: { pass: true, judgeOk: true, scores: { voice: 0.95 } } })],
      orgSlug: "acme",
      orgId: "org-1",
      voiceFloor: null,
    }));
  });
  expect(container.textContent).toContain("Queue error");
  expect(container.textContent).toContain("source post");
  expect(container.textContent).not.toContain("Needs quality review");
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test("DMs off hides every LinkedIn DM and Select all matches the visible replies", async () => {
  await act(async () => {
    root.render(
      createElement(LinkedInReviewInbox, {
        rows: [
          row({ id: "reply", kind: "reply", body: "visible reply", postText: "source post" }),
          row({ id: "legacy", kind: "dm", body: "hidden legacy DM" }),
          row({
            id: "friendly",
            kind: "dm",
            body: "visible friendly DM",
            postText: "saved context source",
            postKind: "relationship_dm",
          }),
        ],
        orgSlug: "acme",
        orgId: "org-1",
      }),
    );
  });

  expect(container.textContent).toContain("source post");
  expect(container.textContent).not.toContain("saved context source");
  expect(container.textContent).not.toContain("hidden legacy DM");
  expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).not.toContain(
    "/app/acme/approvals/ap-friendly",
  );

  const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  expect(boxes).toHaveLength(1);

  const selectAll = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Select all",
  );
  await act(async () => selectAll?.click());
  expect(container.textContent).toContain("1 selected");
});

test("DMs on reveals LinkedIn DMs without adding them to the bulk reply selection", async () => {
  window.localStorage.setItem("noelle.showDms", "1");
  await act(async () => {
    root.render(
      createElement(LinkedInReviewInbox, {
        rows: [
          row({ id: "reply", kind: "reply", body: "visible reply", postText: "source post" }),
          row({
            id: "friendly",
            kind: "dm",
            body: "visible friendly DM",
            postText: "saved context source",
            postKind: "relationship_dm",
          }),
        ],
        orgSlug: "acme",
        orgId: "org-1",
      }),
    );
  });

  const selectAll = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Select all",
  );
  await act(async () => selectAll?.click());
  expect(container.textContent).toContain("saved context source");
  expect(container.textContent).toContain("1 selected");

  await act(async () => {
    window.localStorage.setItem("noelle.showDms", "0");
    window.dispatchEvent(new Event("noelle:showDms"));
  });

  expect(container.textContent).not.toContain("saved context source");
  expect(container.textContent).toContain("1 selected");
});

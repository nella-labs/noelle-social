// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PendingApprovalRow } from "@/lib/queries";

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
  scheduleAutoSend: vi.fn(async () => ({ ok: true, count: 0, firstAt: null, lastAt: null, withheld: 0 })),
  bulkSkipDrafts: vi.fn(async () => ({ ok: true, count: 0 })),
  skipDraft: vi.fn(async () => ({ ok: true })),
  unskipDraft: vi.fn(async () => ({ ok: true })),
}));

import { ReviewInbox } from "./ReviewInbox";

function row(args: {
  id: string;
  kind: "reply" | "dm";
  body: string;
  postKind?: string;
  review?: unknown;
}): PendingApprovalRow {
  return {
    approval: {
      id: `ap-${args.id}`,
      lead_id: `lead-${args.id}`,
      status: "pending",
      created_at: "2026-09-14T10:00:00Z",
      auto_send_target_at: null,
    },
    draft: {
      id: `draft-${args.id}`,
      lead_id: `lead-${args.id}`,
      payload: { kind: args.kind, body: args.body, verifier_meta: args.review },
    },
    lead: {
      id: `lead-${args.id}`,
      external_id: `x-${args.id}`,
      payload: {
        author_handle: args.id,
        post_text: args.kind === "reply" ? args.body : undefined,
        post_kind: args.postKind,
        post_id: "123",
      },
      classifier_score: 0.8,
    },
  } as unknown as PendingApprovalRow;
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

test("labels pending X replies as approved or as a queue invariant error", async () => {
  await act(async () => {
    root.render(createElement(ReviewInbox, {
      rows: [
        row({ id: "ready", kind: "reply", body: "ready text", review: { pass: true, judgeOk: true } }),
        row({ id: "failed", kind: "reply", body: "failed text" }),
      ],
      orgSlug: "acme",
      orgId: "org-1",
    }));
  });
  expect(container.textContent).toContain("Approved");
  expect(container.textContent).toContain("Queue error");
  expect(container.textContent).not.toContain("Needs quality review");
  expect(container.textContent).toContain("failed text");
});

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
});

test("DMs off hides every X DM", async () => {
  await act(async () => {
    root.render(
      createElement(ReviewInbox, {
        rows: [
          row({ id: "reply", kind: "reply", body: "visible reply" }),
          row({ id: "legacy", kind: "dm", body: "hidden companion DM" }),
          row({
            id: "friendly",
            kind: "dm",
            body: "visible friendly DM",
            postKind: "relationship_dm",
          }),
        ],
        orgSlug: "acme",
        orgId: "org-1",
      }),
    );
  });

  expect(container.textContent).toContain("visible reply");
  expect(container.textContent).not.toContain("visible friendly DM");
  expect(container.textContent).not.toContain("hidden companion DM");

  const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  expect(boxes).toHaveLength(1);
  expect(boxes[0]!.disabled).toBe(false);
});

test("DMs on reveals both companion and standalone Friendly DMs", async () => {
  window.localStorage.setItem("noelle.showDms", "1");
  await act(async () => {
    root.render(
      createElement(ReviewInbox, {
        rows: [
          row({ id: "reply", kind: "reply", body: "visible reply" }),
          row({ id: "legacy", kind: "dm", body: "visible companion DM" }),
          row({
            id: "friendly",
            kind: "dm",
            body: "visible friendly DM",
            postKind: "relationship_dm",
          }),
        ],
        orgSlug: "acme",
        orgId: "org-1",
      }),
    );
  });

  expect(container.textContent).toContain("visible reply");
  expect(container.textContent).toContain("visible companion DM");
  expect(container.textContent).toContain("visible friendly DM");
});

test("explains hidden companion DMs instead of claiming the worker has no drafts", async () => {
  await act(async () => {
    root.render(
      createElement(ReviewInbox, {
        rows: [row({ id: "legacy", kind: "dm", body: "hidden companion DM" })],
        orgSlug: "acme",
        orgId: "org-1",
      }),
    );
  });

  expect(container.textContent).toContain("1 DM is hidden");
  expect(container.textContent).not.toContain("sync worker checks every minute");
});

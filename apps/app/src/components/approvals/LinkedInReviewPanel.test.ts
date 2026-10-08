// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

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

const markSentManualMock = vi.fn(async () => ({ ok: true as const }));
const saveDraftEditMock = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/app/app/[orgSlug]/approvals/actions", () => ({
  markSentManual: () => markSentManualMock(),
  unmarkSentManual: vi.fn(async () => ({ ok: true })),
  saveDraftEdit: () => saveDraftEditMock(),
  skipDraft: vi.fn(async () => ({ ok: true })),
}));

import { LinkedInReviewPanel } from "./LinkedInReviewPanel";
import type { LinkedInApprovalView } from "@/lib/queries";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const reply: LinkedInApprovalView = {
  approvalId: "ap-li-1",
  status: "pending",
  createdAt: new Date().toISOString(),
  kind: "reply",
  authorName: "Dana Dev",
  authorHeadline: "Staff Eng",
  authorPublicId: "dana",
  profileUrl: null,
  postText: "A post about scaling Postgres",
  postUrl: null,
  postedAt: null,
  body: "Sharp take — the connection pool is usually the first thing to fall over.",
  angle: "technical",
  charCount: null,
  styleSource: null,
};

let writeText: ReturnType<typeof vi.fn>;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  markSentManualMock.mockClear();
  saveDraftEditMock.mockClear();
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test("copying a LinkedIn draft does not acknowledge a send", async () => {
  await act(async () => {
    root.render(
      createElement(LinkedInReviewPanel, {
        orgSlug: "acme",
        replies: [reply],
        dm: null,
        nextHref: null,
        listHref: "/app/acme/approvals",
      }),
    );
  });

  const copyBtn = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => /Copy/.test(b.textContent ?? ""));
  expect(copyBtn).toBeTruthy();
  expect(writeText).not.toHaveBeenCalled();
  expect(markSentManualMock).not.toHaveBeenCalled();

  await act(async () => {
    copyBtn!.click();
  });

  // Clipboard preparation leaves the send acknowledgment to the operator.
  expect(writeText).toHaveBeenCalledWith(reply.body);
  expect(markSentManualMock).not.toHaveBeenCalled();
});

test("standalone 'Mark sent' still marks sent without copying", async () => {
  await act(async () => {
    root.render(
      createElement(LinkedInReviewPanel, {
        orgSlug: "acme",
        replies: [reply],
        dm: null,
        nextHref: null,
        listHref: "/app/acme/approvals",
      }),
    );
  });

  const markBtn = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => (b.textContent ?? "").trim() === "Mark sent");
  expect(markBtn).toBeTruthy();

  await act(async () => {
    markBtn!.click();
  });

  expect(markSentManualMock).toHaveBeenCalledTimes(1);
  // Marking without copying must not touch the clipboard.
  expect(writeText).not.toHaveBeenCalled();
});


test("a failed LinkedIn edit save aborts manual acknowledgment", async () => {
  saveDraftEditMock.mockResolvedValueOnce({ ok: false, error: { code: "save_failed", message: "Edit was not saved" } } as never);
  await act(async () => root.render(createElement(LinkedInReviewPanel, {
    orgSlug: "acme", replies: [reply], dm: null, listHref: "/app/acme/approvals",
  })));
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "An edited reply");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const mark = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Mark sent")!;
  await act(async () => mark.click());
  expect(saveDraftEditMock).toHaveBeenCalledTimes(1);
  expect(markSentManualMock).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Edit was not saved");
});


test("copying an edited LinkedIn draft waits for its save and aborts a structured failure", async () => {
  let finish!: (result: unknown) => void;
  saveDraftEditMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }) as never);
  await act(async () => root.render(createElement(LinkedInReviewPanel, {
    orgSlug: "acme", replies: [reply], dm: null, listHref: "/app/acme/approvals",
  })));
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "An edited reply");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const copy = Array.from(container.querySelectorAll("button")).find((b) => /^Copy/.test(b.textContent ?? ""))!;
  await act(async () => copy.click());
  expect(saveDraftEditMock).toHaveBeenCalledTimes(1);
  expect(writeText).not.toHaveBeenCalled();
  expect(markSentManualMock).not.toHaveBeenCalled();
  await act(async () => finish({ ok: false, error: { code: "save_failed", message: "Edit was not saved" } }));
  expect(writeText).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Edit was not saved");
});

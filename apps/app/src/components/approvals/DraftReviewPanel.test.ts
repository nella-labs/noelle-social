// @vitest-environment jsdom

/**
 * The reviewer's core ask: clicking a reply angle copies its text (to paste
 * into X) AND selects it as the angle "Approve & send" will use. One gesture,
 * both jobs.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The panel pulls in the Next router and the server actions module; neither is
// exercised here, so stub them so the component renders standalone.
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
const sendDraftMock = vi.fn(
  async (_input: { body: string; originalBody: string; approvalId: string }) => ({
    ok: true as const,
  }),
);
const saveDraftEditMock = vi.fn(
  async (_input: { body: string; approvalId: string }) => ({ ok: true as const }),
);
vi.mock("@/app/app/[orgSlug]/approvals/actions", () => ({
  sendDraft: (input: { body: string; originalBody: string; approvalId: string }) =>
    sendDraftMock(input),
  skipDraft: vi.fn(async () => ({ ok: true })),
  markSentManual: vi.fn(async () => ({ ok: true })),
  saveDraftEdit: (input: { body: string; approvalId: string }) =>
    saveDraftEditMock(input),
}));

import { DraftReviewPanel } from "./DraftReviewPanel";

const angles = [
  { id: "empathetic", kind: "Empathetic", text: "Angle one text", quality: 0.8 },
  { id: "technical", kind: "Technical", text: "Angle two text", quality: 0.7 },
];

let writeText: ReturnType<typeof vi.fn>;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  sendDraftMock.mockClear();
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

test("clicking an angle copies its text and selects it", async () => {
  await act(async () => {
    root.render(
      createElement(DraftReviewPanel, {
        orgSlug: "acme",
        approvalId: "ap1",
        angles,
        nextHref: null,
      }),
    );
  });

  const buttons = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button.angle"),
  );
  expect(buttons).toHaveLength(2);
  // First angle is selected by default; nothing copied yet.
  expect(buttons[0].className).toContain("selected");
  expect(writeText).not.toHaveBeenCalled();

  await act(async () => {
    buttons[1].click();
  });

  // The clicked angle's exact text hit the clipboard...
  expect(writeText).toHaveBeenCalledWith("Angle two text");
  // ...and selection moved to it.
  expect(buttons[1].className).toContain("selected");
  expect(buttons[0].className).not.toContain("selected");
  // ...and it flashes the copied affordance.
  expect(buttons[1].textContent).toContain("Copied");
});

/** Set a controlled textarea's value the way React expects (native setter +
 *  dispatched input event) so onChange fires and state updates. */
function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

test("editing the textarea then Send sends edited body with the original as originalBody", async () => {
  await act(async () => {
    root.render(
      createElement(DraftReviewPanel, {
        orgSlug: "acme",
        approvalId: "ap1",
        angles,
        nextHref: null,
      }),
    );
  });

  const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
  expect(textarea).not.toBeNull();
  // Seeded from the first (selected) angle.
  expect(textarea!.value).toBe("Angle one text");

  await act(async () => {
    typeInto(textarea!, "Angle one text — my edit");
  });

  // Click the red "Send →" button (the last button on the action bar).
  const sendBtn = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => /Send/.test(b.textContent ?? ""));
  expect(sendBtn).toBeTruthy();
  await act(async () => {
    sendBtn!.click();
  });

  expect(sendDraftMock).toHaveBeenCalledTimes(1);
  const arg = sendDraftMock.mock.calls[0]![0];
  // body = the edited text; originalBody = the drafter's angle → edited fires.
  expect(arg.body).toBe("Angle one text — my edit");
  expect(arg.originalBody).toBe("Angle one text");
  expect(arg.body).not.toBe(arg.originalBody);
});

test("not editing keeps body === originalBody (edited stays false)", async () => {
  await act(async () => {
    root.render(
      createElement(DraftReviewPanel, {
        orgSlug: "acme",
        approvalId: "ap1",
        angles,
        nextHref: null,
      }),
    );
  });

  const sendBtn = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => /Send/.test(b.textContent ?? ""));
  await act(async () => {
    sendBtn!.click();
  });

  expect(sendDraftMock).toHaveBeenCalledTimes(1);
  const arg = sendDraftMock.mock.calls[0]![0];
  // Untouched → identical, so the action computes edited = false.
  expect(arg.body).toBe(arg.originalBody);
  expect(arg.body).toBe("Angle one text");
});

// @vitest-environment jsdom

import http from "node:http";
import https from "node:https";
import { Socket } from "node:net";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { VideoIdeaRow } from "@/lib/video-studio-queries";
const f = vi.hoisted(() => ({
  manual: vi.fn(),
  approve: vi.fn(),
  schedule: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/app/[orgSlug]/studio/actions", () => ({
  manualVideoIdea: f.manual,
  approveVideoIdea: f.approve,
  scheduleVideoIdea: f.schedule,
  dismissStudioItem: f.dismiss,
  generateVideoIdeas: vi.fn(),
  getIdeationStatus: vi.fn(),
}));
vi.mock("./InspirationStrip", () => ({ InspirationStrip: () => null }));
import { VideoIdeasStudio } from "./VideoIdeasStudio";
import { IdeasGenerateBar } from "./ideas-board-shell";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
let gates: Array<() => void>;
let errors: unknown[];
beforeEach(() => {
  gates = [];
  errors = [];
  for (const fn of Object.values(f)) fn.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(http, "request").mockImplementation(() => {
    throw new Error("HTTP forbidden");
  });
  vi.spyOn(https, "request").mockImplementation(() => {
    throw new Error("HTTPS forbidden");
  });
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("Socket forbidden");
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Fetch forbidden");
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host, { onUncaughtError: (e) => errors.push(e) });
});
afterEach(async () => {
  await act(async () => gates.forEach((fn) => fn()));
  await act(async () => root.unmount());
  host.remove();
  expect(errors).toEqual([]);
  expect(http.request).not.toHaveBeenCalled();
  expect(https.request).not.toHaveBeenCalled();
  expect(Socket.prototype.connect).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(ideas: VideoIdeaRow[] = []) {
  await act(async () =>
    root.render(createElement(VideoIdeasStudio, { orgSlug: "workspace", ideas })),
  );
}
async function change(node: HTMLInputElement, value: string, event = "input") {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event(event, { bubbles: true }));
  });
}
async function click(label: string) {
  const node = [...host.querySelectorAll("button")].find((node) => node.textContent === label);
  expect(node).toBeDefined();
  await act(async () => node!.click());
}
test("a rejected manual idea keeps the input for retry", async () => {
  f.manual.mockResolvedValue({ ok: false, error: "forbidden" });
  await render();
  const input = host.querySelector<HTMLInputElement>("input[maxlength]")!;
  await change(input, "Operator hook");
  await click("Add idea");
  expect(input.value).toBe("Operator hook");
  expect(host.textContent).toContain("Something went wrong");
});
test("confirmed manual creation clears only its submitted input and describes a proposed idea", async () => {
  await render();
  const input = host.querySelector<HTMLInputElement>("input[maxlength]")!;
  await change(input, "Operator hook");
  await click("Add idea");
  expect(f.manual).toHaveBeenCalledWith({ orgSlug: "workspace", hook: "Operator hook" });
  expect(input.value).toBe("");
  expect(host.textContent).toContain("Generate draft");
  expect(host.textContent).not.toContain("Nova will draft it");
  expect([...host.querySelectorAll("button")].some((node) => node.textContent === "Add idea")).toBe(
    true,
  );
});
test("a delayed manual receipt preserves input typed after submission", async () => {
  await render();
  const input = host.querySelector<HTMLInputElement>("input[maxlength]")!;
  await change(input, "First hook");
  let release!: () => void;
  f.manual.mockReturnValue(
    new Promise((resolve) => {
      release = () => resolve({ ok: true });
    }),
  );
  gates.push(release);
  await click("Add idea");
  await change(input, "Newer hook");
  await act(async () => release());
  expect(input.value).toBe("Newer hook");
});
test("manual transport failure remains visible and preserves the input", async () => {
  f.manual.mockRejectedValue(new Error("transport failed"));
  await render();
  const input = host.querySelector<HTMLInputElement>("input[maxlength]")!;
  await change(input, "Operator hook");
  await click("Add idea");
  expect(input.value).toBe("Operator hook");
  expect(host.textContent).toContain("Could not confirm");
});
test("the shared manual bar retains its text-lane default", async () => {
  await act(async () =>
    root.render(
      createElement(IdeasGenerateBar, {
        eyebrow: "Ideas",
        description: "Description",
        count: 1,
        setCount: vi.fn(),
        onGenerate: vi.fn(),
        onBatch: vi.fn(),
        genBusy: false,
        own: "Hook",
        setOwn: vi.fn(),
        onAddOwn: vi.fn(),
        ownPlaceholder: "Hook",
        ownBusy: false,
      }),
    ),
  );
  expect(host.textContent).toContain("Add & draft");
});
const idea = {
  id: "idea-a",
  hook: "Current idea",
  concept: null,
  pillar: null,
  angle: null,
  status: "proposed",
  batch_id: null,
  suggested_day: null,
  inspiration_clip_ids: [],
  inspiration: [],
  inspirationIsFallback: false,
  created_at: "2026-10-06",
} satisfies VideoIdeaRow;
for (const [name, action] of [
  ["approve", f.approve],
  ["dismiss", f.dismiss],
] as const)
  test(`${name} failure is displayed by the current idea caller`, async () => {
    action.mockResolvedValue({ ok: false, error: "not_found" });
    await render([idea]);
    await click(name === "approve" ? "Generate draft →" : "Dismiss");
    expect(host.textContent).toContain("Something went wrong");
  });
test("schedule failure is displayed by the current idea caller", async () => {
  f.schedule.mockResolvedValue({ ok: false, error: "not_found" });
  await render([idea]);
  await change(host.querySelector<HTMLInputElement>("input[type=date]")!, "2026-10-12", "change");
  expect(f.schedule).toHaveBeenCalledWith({
    orgSlug: "workspace",
    ideaId: "idea-a",
    day: "2026-10-12",
  });
  expect(host.textContent).toContain("Something went wrong");
});

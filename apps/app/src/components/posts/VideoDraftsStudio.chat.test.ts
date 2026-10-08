// @vitest-environment jsdom

import http from "node:http";
import https from "node:https";
import { Socket } from "node:net";
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ScriptEditProposal } from "@noelle/contracts";
import type { VideoDraftRow } from "@/lib/video-studio-queries";

const seam = vi.hoisted(() => ({
  script: vi.fn(),
  beats: vi.fn(),
  ready: vi.fn(),
  dismiss: vi.fn(),
  manual: vi.fn(),
  refresh: vi.fn(),
  apply: null as null | ((edit: ScriptEditProposal) => boolean),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: seam.refresh }) }));
vi.mock("@/app/app/[orgSlug]/studio/actions", () => ({
  saveVideoDraftScript: seam.script,
  saveVideoDraftStructure: seam.beats,
  markVideoDraftReady: seam.ready,
  dismissStudioItem: seam.dismiss,
  manualVideoIdea: seam.manual,
  generateVideoIdeas: vi.fn(),
  getIdeationStatus: vi.fn(),
  approveVideoIdea: vi.fn(),
  scheduleVideoIdea: vi.fn(),
}));
vi.mock("@/components/agent-panels/AgentChat", () => ({
  AgentChat: (props: { onApplyScriptEdit: typeof seam.apply }) => {
    seam.apply = props.onApplyScriptEdit;
    return null;
  },
}));
vi.mock("@/components/constellation/Avatar", () => ({ Avatar: () => null }));
vi.mock("@/app/app/[orgSlug]/studio/StudioStillGenerator", () => ({
  StudioStillGenerator: () => null,
}));
vi.mock("@/components/posts/remotion/VisualPreview", () => ({ ReelPreview: () => null }));
vi.mock("@/components/posts/ClipDetailModal", () => ({ ClipDetailModal: () => null }));
vi.mock("@/components/posts/DraftVisualsPanel", () => ({
  VisualCard: () => null,
  graphSpecSeconds: () => null,
  footageCues: () => [],
}));
vi.mock("@/components/posts/InspirationStrip", () => ({ InspirationStrip: () => null }));
import { VideoDraftsStudio } from "./VideoDraftsStudio";
import { AutoRefresh } from "@/app/app/[orgSlug]/approvals/AutoRefresh";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const draft = (patch: Partial<VideoDraftRow> = {}): VideoDraftRow => ({
  id: "draft-a",
  idea_id: "idea-a",
  idea_hook: "First hook",
  script: "Original script",
  final_script: null,
  structure: [{ tStart: 0, tEnd: 2, purpose: "hook", line: "Original beat" }],
  transitions: [],
  sounds: [],
  graph_specs: [],
  status: "draft",
  quality_passed: true,
  verifier_meta: null,
  inspiration: [],
  inspiration_clip_ids: [],
  inspirationIsFallback: false,
  created_at: "2026-10-06",
  ...patch,
});
let host: HTMLDivElement, root: Root;
let gates: Array<() => void>;
let errors: unknown[];
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  gates.push(() => resolve(fallback));
  return { promise, resolve };
}
beforeEach(() => {
  gates = [];
  errors = [];
  seam.apply = null;
  for (const fn of [seam.script, seam.beats, seam.ready, seam.dismiss, seam.manual])
    fn.mockReset().mockResolvedValue({ ok: true });
  seam.refresh.mockReset();
  vi.spyOn(http, "request").mockImplementation(() => {
    throw new Error("HTTP forbidden in Studio proof");
  });
  vi.spyOn(https, "request").mockImplementation(() => {
    throw new Error("HTTPS forbidden in Studio proof");
  });
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("Socket forbidden in Studio proof");
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Fetch forbidden in Studio proof");
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host, { onUncaughtError: (e) => errors.push(e) });
});
afterEach(async () => {
  await act(async () => {
    gates.forEach((release) => release());
  });
  await act(async () => root.unmount());
  host.remove();
  expect(http.request).not.toHaveBeenCalled();
  expect(https.request).not.toHaveBeenCalled();
  expect(Socket.prototype.connect).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(errors).toEqual([]);
});
async function render(rows = [draft()], ticker = false) {
  await act(async () =>
    root.render(
      createElement(
        Fragment,
        null,
        ticker ? createElement(AutoRefresh, { intervalMs: 30000 }) : null,
        createElement(VideoDraftsStudio, {
          orgSlug: "workspace",
          instanceId: "instance-a",
          drafts: rows,
        }),
      ),
    ),
  );
}
function values() {
  return [...host.querySelectorAll("textarea")].map((node) => node.value);
}
function saves() {
  return [...host.querySelectorAll("button")].filter((node) => node.textContent === "Save");
}
async function change(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(label: string) {
  const node = [...host.querySelectorAll("button")].find(
    (node) => node.textContent === label || node.getAttribute("aria-label") === label,
  );
  expect(node, label).toBeDefined();
  await act(async () => node!.click());
}
test("dirty beats and script survive the actual thirty-second refresh ticker", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await render([draft()], true);
  await change(host.querySelectorAll("textarea")[0], "Local beat");
  await change(host.querySelectorAll("textarea")[1], "Local script");
  expect(values()).toEqual(["Local beat", "Local script"]);
  expect(saves().length).toBeGreaterThan(0);
  seam.refresh.mockImplementation(() =>
    root.render(
      createElement(
        Fragment,
        null,
        createElement(AutoRefresh, { intervalMs: 30000 }),
        createElement(VideoDraftsStudio, {
          orgSlug: "workspace",
          instanceId: "instance-a",
          drafts: [draft()],
        }),
      ),
    ),
  );
  await act(async () => vi.advanceTimersByTime(30000));

  expect(seam.refresh).toHaveBeenCalledTimes(1);
  expect(values()).toEqual(["Local beat", "Local script"]);
});
test("a rejected script save remains dirty and reviewable", async () => {
  await render();
  await change(host.querySelectorAll("textarea")[1], "Local script");
  seam.script.mockResolvedValue({ ok: false, error: "forbidden" });
  await click("Save");
  expect(seam.script).toHaveBeenCalledWith({
    orgSlug: "workspace",
    draftId: "draft-a",
    script: "Local script",
  });
  expect(saves().length).toBeGreaterThan(0);
});
test("failed beat persistence prevents marking the draft ready", async () => {
  await render();
  await change(host.querySelectorAll("textarea")[0], "Local beat");
  seam.beats.mockResolvedValue({ ok: false, error: "not_found" });
  await click("Mark ready to film");
  expect(seam.ready).not.toHaveBeenCalled();
  expect(saves().length).toBeGreaterThan(0);
});
test("a late save receipt cannot clean edits typed during that save", async () => {
  await render();
  await change(host.querySelectorAll("textarea")[1], "First local script");
  const held = deferred({ ok: true });
  seam.script.mockReturnValue(held.promise);
  const button = saves()[0];
  await act(async () => button.click());
  await change(host.querySelectorAll("textarea")[1], "Newer local script");
  await act(async () => held.resolve({ ok: true }));

  expect(values()).toContain("Newer local script");
  expect(seam.script.mock.calls[0][0].script).toBe("First local script");
  expect(saves().length).toBeGreaterThan(0);
});
test("a prior draft's late save cannot clean the newly opened draft", async () => {
  const second = draft({
    id: "draft-b",
    idea_id: "idea-b",
    idea_hook: "Second hook",
    script: "Second script",
  });
  await render([draft(), second]);
  await change(host.querySelectorAll("textarea")[1], "First local script");
  const held = deferred({ ok: true });
  seam.script.mockReturnValue(held.promise);
  await act(async () => saves()[0].click());
  const card = [...host.querySelectorAll("button")].find((node) =>
    node.textContent?.includes("Second hook"),
  )!;
  await act(async () => card.click());
  await change(host.querySelectorAll("textarea")[1], "Second local script");
  await act(async () => held.resolve({ ok: true }));

  expect(seam.script.mock.calls[0][0].draftId).toBe("draft-a");
  expect(values()).toContain("Second local script");
  expect(saves().length).toBeGreaterThan(0);
});
test("clean same-ID refresh adopts current saved data", async () => {
  await render();
  await render([
    draft({
      final_script: "Current saved script",
      structure: [{ tStart: 0, tEnd: 2, purpose: "hook", line: "Current saved beat" }],
    }),
  ]);
  expect(values()).toEqual(["Current saved beat", "Current saved script"]);
  expect(saves()).toHaveLength(0);
});
test("opening a different draft uses that draft's saved buffer", async () => {
  const second = draft({
    id: "draft-b",
    idea_id: "idea-b",
    idea_hook: "Second hook",
    script: "Second script",
  });
  await render([draft(), second]);
  await change(host.querySelectorAll("textarea")[1], "First local script");
  const card = [...host.querySelectorAll("button")].find((node) =>
    node.textContent?.includes("Second hook"),
  )!;
  await act(async () => card.click());
  expect(values()).toEqual(["Original beat", "Second script"]);
  expect(saves()).toHaveLength(0);
});
test("a confirmed save sends the current draft and clears its matching buffer", async () => {
  await render();
  await change(host.querySelectorAll("textarea")[1], "Local script");
  await click("Save");
  expect(seam.script).toHaveBeenCalledWith({
    orgSlug: "workspace",
    draftId: "draft-a",
    script: "Local script",
  });
  expect(saves()).toHaveLength(0);
});

async function mount() {
  await render();
  await click("Talk to Nova →");
}
test("out-of-range and identical edits report a no-op without dirtying the editor", async () => {
  await mount();
  let result: boolean | undefined;
  await act(async () => {
    result = seam.apply!({ beats: [{ index: 8, line: "Detached beat" }], summary: "Rewrite" });
  });
  expect(result).toBe(false);
  expect([...host.querySelectorAll("button")].filter((b) => b.textContent === "Save")).toHaveLength(
    0,
  );
  await act(async () => {
    result = seam.apply!({ fullScript: "Original script", summary: "Same script" });
  });
  expect(result).toBe(false);
  expect([...host.querySelectorAll("button")].filter((b) => b.textContent === "Save")).toHaveLength(
    0,
  );
  await act(async () => {
    result = seam.apply!({
      beats: [
        { index: 0, line: "Valid change" },
        { index: 8, line: "Detached change" },
      ],
      fullScript: "Detached rewrite",
      summary: "Invalid partial edit",
    });
  });
  expect(result).toBe(false);
  expect([...host.querySelectorAll("textarea")].map((input) => input.value)).toContain(
    "Original script",
  );
});
test("applicable beat and full-script edits acknowledge actual local changes", async () => {
  await mount();
  let result: boolean | undefined;
  await act(async () => {
    result = seam.apply!({
      beats: [{ index: 0, line: "Updated line" }],
      fullScript: "Updated script",
      summary: "Rewrite",
    });
  });
  expect(result).toBe(true);
  const values = [...host.querySelectorAll("textarea")].map((input) => input.value);
  expect(values).toContain("Updated line");
  expect(values).toContain("Updated script");
  expect(
    [...host.querySelectorAll("button")].filter((b) => b.textContent === "Save").length,
  ).toBeGreaterThan(0);
});

test("only the confirmed field is cleaned when another field fails", async () => {
  await render();
  await change(host.querySelectorAll("textarea")[0], "Saved beat");
  await change(host.querySelectorAll("textarea")[1], "Unsaved script");
  seam.script.mockResolvedValue({ ok: false, error: "not_found" });
  await click("Save");
  expect(saves().length).toBeGreaterThan(0);
  seam.script.mockResolvedValue({ ok: true });
  await click("Save");
  expect(seam.beats).toHaveBeenCalledTimes(1);
  expect(seam.script).toHaveBeenCalledTimes(2);
  expect(saves()).toHaveLength(0);
});
test("dirty storyboard metadata stays attached to its lines across refresh", async () => {
  await render();
  await change(host.querySelectorAll("textarea")[0], "Local beat");
  await render([
    draft({ structure: [{ tStart: 10, tEnd: 20, purpose: "new timing", line: "Server beat" }] }),
  ]);
  await click("Save");
  expect(seam.beats).toHaveBeenCalledWith({
    orgSlug: "workspace",
    draftId: "draft-a",
    structure: [{ tStart: 0, tEnd: 2, purpose: "hook", line: "Local beat" }],
  });
});
test("transport failure keeps the edit retryable and displays uncertainty", async () => {
  await render();
  await change(host.querySelectorAll("textarea")[1], "Local script");
  seam.script.mockRejectedValue(new Error("transport failed"));
  await click("Save");
  expect(saves().length).toBeGreaterThan(0);
  expect(host.textContent).toContain("Could not confirm");
});

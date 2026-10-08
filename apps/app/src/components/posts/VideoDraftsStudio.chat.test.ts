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

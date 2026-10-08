// @vitest-environment jsdom
import http from "node:http";
import https from "node:https";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const actions = vi.hoisted(() => ({ load: vi.fn(), move: vi.fn(), skip: vi.fn() }));
vi.mock("@/app/app/[orgSlug]/content/schedule-actions", () => ({
  loadScheduleSlotsAction: actions.load,
  rescheduleSlotAction: actions.move,
  skipSlotAction: actions.skip,
}));
import { ScheduleCalendar, type CalendarSlot } from "./ScheduleCalendar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const slotId = "11111111-1111-4111-8111-111111111111";
const readySlot = (overrides: Partial<CalendarSlot> = {}): CalendarSlot => ({
  id: slotId, slotAt: "2026-10-06T12:00:00Z", platform: "x", status: "ready",
  autoPublish: false, preview: "Current scheduled body", hook: null, ...overrides,
});
const initial = { orgSlug: "first-org", today: "2026-10-06", initialWindow: { from: "2026-09-28T00:00:00Z", to: "2026-10-26T00:00:00Z" },
  slots: [] as CalendarSlot[], platform: "x", laneColor: "var(--accent)", canAutoPost: true, emptyHint: "No slots in this view." };
let host: HTMLDivElement, root: Root;
let renderErrors: unknown[];
let release: Array<() => void>;
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  release.push(() => resolve(fallback));
  return { promise, resolve };
}
beforeEach(() => {
  release = []; renderErrors = [];
  actions.load.mockReset().mockResolvedValue([]);
  actions.move.mockReset().mockResolvedValue({ id: slotId, slot_at: "2026-10-07T12:00:00Z", status: "ready", auto_publish: false });
  actions.skip.mockReset().mockResolvedValue({ id: slotId, status: "skipped" });
  vi.spyOn(http, "request").mockImplementation(() => { throw new Error("HTTP forbidden in schedule proof"); });
  vi.spyOn(https, "request").mockImplementation(() => { throw new Error("HTTPS forbidden in schedule proof"); });
  vi.spyOn(http, "get").mockImplementation(() => { throw new Error("HTTP GET forbidden in schedule proof"); });
  vi.spyOn(https, "get").mockImplementation(() => { throw new Error("HTTPS GET forbidden in schedule proof"); });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Fetch forbidden in schedule proof"); }));
  host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host, { onUncaughtError: error => { renderErrors.push(error); } });
});
afterEach(async () => {
  await act(async () => { for (const finish of release) finish(); });
  await act(async () => root.unmount()); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function render(props: Partial<typeof initial> = {}) {
  await act(async () => root.render(createElement(ScheduleCalendar, { ...initial, ...props })));
}
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find(node => node.getAttribute("aria-label") === label || node.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
const chip = (text = "Current scheduled body") => host.querySelector<HTMLDivElement>(`[title="${text}"]`);
const weekCell = (index: number) => host.querySelector(".scroll-x-phone")?.children[index];
async function dragTo(index: number, text?: string) {
  const item = chip(text), cell = weekCell(index);
  expect(item).not.toBeNull(); expect(cell).toBeDefined();
  await act(async () => {
    item!.dispatchEvent(new Event("dragstart", { bubbles: true }));
    cell!.dispatchEvent(new Event("drop", { bubbles: true }));
  });
}
async function nextFourWeeks() { for (let i = 0; i < 4; i++) await click("Next"); }

test("initial current-week slots render without a redundant read", async () => {
  await render({ slots: [readySlot()] });
  expect(chip()).not.toBeNull(); expect(actions.load).not.toHaveBeenCalled();
  expect(renderErrors).toEqual([]);
});
test("a ready slot's normal drag retains its time and dispatches once", async () => {
  await render({ slots: [readySlot()] });
  await dragTo(2);
  expect(actions.move).toHaveBeenCalledExactlyOnceWith("first-org", slotId, "2026-10-07T12:00:00Z");
  expect(weekCell(2)?.contains(chip())).toBe(true);
});
test("a month view loads the rest of a partially covered initial month", async () => {
  const lastOctober = readySlot({ slotAt: "2026-10-30T12:00:00Z", preview: "Later October body" });
  actions.load.mockImplementation(async (_org, _platform, from, to) => from <= lastOctober.slotAt && lastOctober.slotAt < to ? [lastOctober] : []);
  await render(); await click("month");
  expect(chip("Later October body")).not.toBeNull();
});
test("failed month reads remain retryable on normal navigation", async () => {
  actions.load.mockRejectedValueOnce(new Error("Inert read unavailable")).mockResolvedValue([]);
  await render(); for (let i = 0; i < 3; i++) await click("Next");
  expect(actions.load).toHaveBeenCalledTimes(1);
  await click("Previous"); await click("Next");
  expect(actions.load).toHaveBeenCalledTimes(2);
});
test("fresh server rows override a previously fetched row for the same slot", async () => {
  const old = readySlot({ slotAt: "2026-11-03T12:00:00Z", preview: "Old fetched body" });
  actions.load.mockImplementation(async (_org, _platform, from, to) => from <= old.slotAt && old.slotAt < to ? [old] : []);
  await render(); await nextFourWeeks();
  expect(chip("Old fetched body")).not.toBeNull();
  await render({ today: "2026-11-03", initialWindow: { from: "2026-10-26T00:00:00Z", to: "2026-11-23T00:00:00Z" },
    slots: [readySlot({ slotAt: "2026-11-03T12:00:00Z", status: "published", preview: "Fresh server body" })] });
  expect(chip("Fresh server body")).not.toBeNull();
  expect(chip("Old fetched body")).toBeNull();
});
test("late fetch results cannot populate a different organization and lane", async () => {
  const request = deferred<CalendarSlot[]>([]);
  actions.load.mockReturnValueOnce(request.promise);
  await render(); for (let i = 0; i < 3; i++) await click("Next");
  expect(actions.load).toHaveBeenCalledTimes(1);
  await render({ orgSlug: "second-org", platform: "linkedin" });
  await act(async () => request.resolve([readySlot({ slotAt: "2026-11-01T12:00:00Z", preview: "First org private body" })]));
  expect(chip("First org private body")).toBeNull();
});
test("a later authoritative server date replaces the old optimistic move", async () => {
  await render({ slots: [readySlot()] }); await dragTo(2);
  await render({ slots: [readySlot({ slotAt: "2026-10-09T12:00:00Z" })] });
  expect(weekCell(4)?.contains(chip())).toBe(true);
  expect(weekCell(2)?.contains(chip())).toBe(false);
});
test("a rejected move keeps the calendar available instead of crashing its render", async () => {
  actions.move.mockRejectedValue(new Error("Inert publication conflict"));
  actions.load.mockResolvedValue([readySlot()]);
  await render({ slots: [readySlot()] });
  let escaped: unknown;
  try { await dragTo(2); } catch (error) { escaped = error; }
  expect(escaped).toBeUndefined();
  expect(renderErrors).toEqual([]);
  expect(weekCell(1)?.contains(chip())).toBe(true);
});
test.each(["published", "publishing"])("a %s slot exposes no remove or drag mutation", async status => {
  await render({ slots: [readySlot({ status })] });
  const item = chip(); expect(item).not.toBeNull();
  expect.soft(item?.draggable).toBe(false);
  const remove = host.querySelector('[aria-label="Remove from schedule"]');
  expect.soft(remove).toBeNull();
  await dragTo(2);
  if (remove) await click("Remove from schedule");
  expect.soft(actions.move).not.toHaveBeenCalled();
  expect.soft(actions.skip).not.toHaveBeenCalled();
});

test("a read started before a confirmed move cannot restore the old date", async () => {
  const stale = deferred<CalendarSlot[]>([]);
  actions.load.mockReturnValueOnce(stale.promise).mockResolvedValue([readySlot({ slotAt: "2026-10-07T12:00:00Z" })]);
  await render({ initialWindow: { from: "2026-10-05T00:00:00Z", to: "2026-10-07T00:00:00Z" }, slots: [readySlot()] });
  await dragTo(2);
  await act(async () => stale.resolve([readySlot()]));
  expect(weekCell(2)?.contains(chip())).toBe(true);
  expect(weekCell(1)?.contains(chip())).toBe(false);
  expect(actions.load).toHaveBeenCalledTimes(2);
});

test.each(["published", "publishing"])("a %s month chip cannot dispatch a drop", async status => {
  const slot = readySlot({ status });
  actions.load.mockResolvedValue([slot]);
  await render({ slots: [slot] }); await click("month");
  const item = chip(); expect(item?.draggable).toBe(false);
  const cell = item?.parentElement?.parentElement;
  expect(cell?.nextElementSibling).not.toBeNull();
  await act(async () => {
    item!.dispatchEvent(new Event("dragstart", { bubbles: true }));
    cell!.nextElementSibling!.dispatchEvent(new Event("drop", { bubbles: true }));
  });
  expect(actions.move).not.toHaveBeenCalled();
  expect(actions.skip).not.toHaveBeenCalled();
});
test("a rejected removal is unconfirmed and reloads current rows without escaping", async () => {
  actions.skip.mockRejectedValue(new Error("Inert publication conflict"));
  actions.load.mockResolvedValue([readySlot()]);
  await render({ slots: [readySlot()] }); await click("Remove from schedule");
  expect(chip()).not.toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not confirm");
  expect(actions.load).toHaveBeenCalledExactlyOnceWith("first-org", "x", "2026-10-05T00:00:00Z", "2026-10-12T00:00:00Z");
  expect(renderErrors).toEqual([]);
});
test("an unavailable empty range offers one explicit retry before claiming it empty", async () => {
  actions.load.mockRejectedValueOnce(new Error("Inert read unavailable")).mockResolvedValue([]);
  await render(); for (let i = 0; i < 3; i++) await click("Next");
  expect(host.textContent).not.toContain(initial.emptyHint);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
  expect(actions.load).toHaveBeenCalledTimes(1);
  await click("Retry load");
  expect(actions.load).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain(initial.emptyHint);
});
test("pending navigation coalesces to the latest window while the old real read holds admission", async () => {
  const old = deferred<CalendarSlot[]>([]);
  actions.load.mockReturnValueOnce(old.promise).mockResolvedValue([]);
  await render(); for (let i = 0; i < 3; i++) await click("Next");
  await render({ orgSlug: "second-org", platform: "linkedin" });
  for (let i = 0; i < 12; i++) await click("Next");
  expect(actions.load).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain(initial.emptyHint);
  await act(async () => old.resolve([]));
  expect(actions.load).toHaveBeenCalledTimes(2);
  expect(actions.load.mock.calls[1]).toEqual(["second-org", "linkedin", "2027-01-18T00:00:00Z", "2027-01-25T00:00:00Z"]);
});
test("refreshing server props refetches an uncovered far window and removes a deleted row", async () => {
  const far = readySlot({ slotAt: "2026-11-03T12:00:00Z", preview: "Far scheduled body" });

import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ org: vi.fn(), rows: vi.fn(), fetch: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/queries", () => ({ getOrgBySlug: fixture.org }));
vi.mock("@/lib/schedule-queries", () => ({ listScheduleSlotsForOrg: fixture.rows }));
vi.mock("@/lib/api", () => ({ noelleFetch: fixture.fetch }));
vi.mock("next/cache", () => ({ revalidatePath: fixture.revalidate }));
import { loadScheduleSlotsAction, rescheduleSlotAction, skipSlotAction } from "./schedule-actions";

const orgId = "11111111-1111-4111-8111-111111111111";
const slotId = "22222222-2222-4222-8222-222222222222";
const nextAt = "2026-10-07T12:00:00Z";
beforeEach(() => {
  fixture.org.mockReset().mockResolvedValue({ id: orgId });
  fixture.rows.mockReset().mockResolvedValue([{ id: slotId, slot_at: nextAt, platform: "x", status: "ready", auto_publish: false, preview: "Current body", hook: null }]);
  fixture.fetch.mockReset().mockResolvedValue({ id: slotId, slot_at: nextAt, status: "ready", auto_publish: false });
  fixture.revalidate.mockReset();
  vi.spyOn(http, "request").mockImplementation(() => { throw new Error("HTTP forbidden in schedule action proof"); });
  vi.spyOn(https, "request").mockImplementation(() => { throw new Error("HTTPS forbidden in schedule action proof"); });
  vi.spyOn(http, "get").mockImplementation(() => { throw new Error("HTTP GET forbidden in schedule action proof"); });
  vi.spyOn(https, "get").mockImplementation(() => { throw new Error("HTTPS GET forbidden in schedule action proof"); });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Fetch forbidden in schedule action proof"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
test("a real load action forwards the resolved organization and exact half-open range", async () => {
  const from = "2026-11-01T00:00:00Z", to = "2026-12-01T00:00:00Z";
  expect(await loadScheduleSlotsAction("fixture", "x", from, to)).toEqual([{ id: slotId, slotAt: nextAt, platform: "x", status: "ready", autoPublish: false, preview: "Current body", hook: null }]);
  expect(fixture.rows).toHaveBeenCalledExactlyOnceWith(orgId, { from, to }, "x");
});
test("a missing organization is unavailable rather than a confirmed empty calendar window", async () => {
  fixture.org.mockResolvedValue(null);
  await expect(loadScheduleSlotsAction("gone", "x", "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z")).rejects.toThrow();
  expect(fixture.rows).not.toHaveBeenCalled();
});
test("a successful actual reschedule action dispatches the current wire and revalidates", async () => {
  expect(await rescheduleSlotAction("fixture", slotId, nextAt)).toEqual({ id: slotId, slot_at: nextAt, status: "ready", auto_publish: false });
  expect(fixture.fetch).toHaveBeenCalledExactlyOnceWith(`/api/content/slots/${slotId}`, { method: "PATCH", body: { slotAt: nextAt } });
  expect(fixture.revalidate).toHaveBeenCalledExactlyOnceWith("/app/fixture/content");
});

test("a confirmed skip keeps the API's reduced receipt shape", async () => {
  fixture.fetch.mockResolvedValue({ id: slotId, status: "skipped" });
  expect(await skipSlotAction("fixture", slotId)).toEqual({ id: slotId, status: "skipped" });
  expect(fixture.fetch).toHaveBeenCalledExactlyOnceWith(`/api/content/slots/${slotId}`, { method: "DELETE" });
  expect(fixture.revalidate).toHaveBeenCalledExactlyOnceWith("/app/fixture/content");
});
test.each([
  { id: "33333333-3333-4333-8333-333333333333", slot_at: nextAt, status: "ready", auto_publish: false },
  { id: slotId, status: "ready", auto_publish: false },
  { id: slotId, slot_at: nextAt, status: "invalid", auto_publish: false },
  null,
])("an unconfirmed move receipt cannot falsely revalidate", async receipt => {
  fixture.fetch.mockResolvedValue(receipt);
  await expect(rescheduleSlotAction("fixture", slotId, nextAt)).rejects.toThrow();
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  expect(fixture.revalidate).not.toHaveBeenCalled();
});
test.each([
  { id: "33333333-3333-4333-8333-333333333333", status: "skipped" },
  { id: slotId, status: "ready" },
  {},
])("an unconfirmed skip receipt cannot falsely revalidate", async receipt => {
  fixture.fetch.mockResolvedValue(receipt);
  await expect(skipSlotAction("fixture", slotId)).rejects.toThrow();
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  expect(fixture.revalidate).not.toHaveBeenCalled();
});
test.each(["move", "skip"])("a rejected actual %s action propagates without a false successful refresh", async operation => {
  fixture.fetch.mockRejectedValue(new Error("Inert409 publication conflict"));
  const run = operation === "move" ? () => rescheduleSlotAction("fixture", slotId, nextAt) : () => skipSlotAction("fixture", slotId);
  await expect(run()).rejects.toThrow("Inert409 publication conflict");
  expect(fixture.revalidate).not.toHaveBeenCalled();
});

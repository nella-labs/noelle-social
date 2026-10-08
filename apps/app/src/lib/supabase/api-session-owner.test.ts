import { afterEach, beforeEach, expect, it, vi } from "vitest";

type FakeWorker = {
  terminated: boolean;
  emit(event: string, value?: unknown): boolean;
};
const fixture = vi.hoisted(() => ({
  workers: [] as FakeWorker[],
  holdTermination: false,
  terminationReleases: [] as (() => void)[],
  failStart: false,
}));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { Worker: class extends EventEmitter {
    terminated = false;
    constructor() {
      super();
      if (fixture.failStart) throw new Error("synthetic worker startup failure");
      fixture.workers.push(this);
    }
    async terminate() {
      this.terminated = true;
      if (fixture.holdTermination) await new Promise<void>(resolve => fixture.terminationReleases.push(resolve));
      this.emit("exit", 1);
      return 1;
    }
  } };
});
import { ApiSessionOwner } from "./api-session-owner";

const snapshot = { url: "https://synthetic.supabase.co", anonKey: "synthetic-anon", cookieName: "synthetic-auth", cookies: [] };
let owner: ApiSessionOwner;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  fixture.workers = []; fixture.terminationReleases = []; fixture.holdTermination = false; fixture.failStart = false;
  owner = new ApiSessionOwner();
});
afterEach(async () => {
  fixture.holdTermination = false;
  for (const release of fixture.terminationReleases.splice(0)) release();
  await owner.close(); vi.useRealTimers();
});

it("keeps ordinary eight-way requests within four active threads and closes each before settling", async () => {
  const requests = Array.from({ length: 8 }, () => owner.request(snapshot));
  expect(fixture.workers).toHaveLength(4);
  for (const worker of fixture.workers.slice()) worker.emit("message", { accessToken: "synthetic-token", cookies: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.workers).toHaveLength(8);
  for (const worker of fixture.workers.slice(4)) worker.emit("message", { accessToken: "synthetic-token", cookies: [] });
  expect(await Promise.all(requests)).toHaveLength(8);
  expect(fixture.workers.every(worker => worker.terminated)).toBe(true);
});

it("rejects the thirty-third admission without creating a thread", async () => {
  const requests = Array.from({ length: 32 }, () => owner.request(snapshot).catch(error => error));
  await expect(owner.request(snapshot)).rejects.toMatchObject({ code: "busy" });
  expect(fixture.workers).toHaveLength(4);
  await owner.close(); await Promise.all(requests);
});

it("expires a queued request before thread creation", async () => {
  const active = Array.from({ length: 4 }, () => owner.request(snapshot).catch(error => error));
  const queued = owner.request(snapshot, 40).catch(error => error);
  await vi.advanceTimersByTimeAsync(40);
  expect(await queued).toMatchObject({ code: "timeout" });
  expect(fixture.workers).toHaveLength(4);
  await owner.close(); await Promise.all(active);
});

it("awaits actual thread termination on the executing deadline and ignores a late result", async () => {
  fixture.holdTermination = true;
  let settled = false;
  const result = owner.request(snapshot, 40).catch(error => { settled = true; return error; });
  await vi.advanceTimersByTimeAsync(40);
  expect(fixture.workers[0]!.terminated).toBe(true);
  expect(settled).toBe(false);
  fixture.workers[0]!.emit("message", { accessToken: "late-token", cookies: [] });
  fixture.terminationReleases.shift()!();
  expect(await result).toMatchObject({ code: "timeout" });
});

it("does not settle a successful result until its thread has stopped", async () => {
  fixture.holdTermination = true;
  let settled = false;
  const result = owner.request(snapshot).then(value => { settled = true; return value; });
  fixture.workers[0]!.emit("message", { accessToken: "synthetic-token", cookies: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  fixture.terminationReleases.shift()!();
  expect(await result).toMatchObject({ accessToken: "synthetic-token" });
});

it("recovers from a pre-execution startup failure without dispatching or retaining a slot", async () => {
  fixture.failStart = true;
  await expect(owner.request(snapshot)).rejects.toMatchObject({ code: "unavailable" });
  fixture.failStart = false;
  const result = owner.request(snapshot);
  fixture.workers[0]!.emit("message", { accessToken: null, cookies: [] });
  expect(await result).toMatchObject({ accessToken: null });
});

it("fails closed when a thread exits without a result", async () => {
  const result = owner.request(snapshot).catch(error => error);
  fixture.workers[0]!.emit("exit", 0);
  expect(await result).toMatchObject({ code: "unavailable" });
});

it.each([0, -1, 8_001, NaN, Infinity, 1.5])("rejects invalid admission timeout %s", async timeout => {
  await expect(owner.request(snapshot, timeout)).rejects.toMatchObject({ code: "invalid_request" });
  expect(fixture.workers).toHaveLength(0);
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  current: {} as unknown,
  stored: null as Record<string, unknown> | null,
  found: true,
  opened: 0,
  closed: 0,
  txReads: [] as boolean[],
  releaseRead: null as (() => void) | null,
  read: null as (() => Promise<void>) | null,
  second: null as (() => void) | null,
  tail: Promise.resolve(),
}));
async function transaction<T>(work: () => Promise<T>): Promise<T> {
  const prior = state.tail;
  let release!: () => void;
  state.tail = new Promise<void>(done => { release = done; });
  if (state.opened > 1) state.second?.();
  await prior;
  try { return await work(); } finally { release(); }
}
function query(inTransaction = false) {
  return Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    if (text.includes("select ai.id")) return state.found ? [{ id: "instance", org_id: "org" }] : [];
    if (text.includes("select account_feeder_config")) {
      const snapshot = structuredClone(state.current);
      state.txReads.push(inTransaction);
      if (state.txReads.length > 1) state.second?.();
      const pause = state.read; state.read = null;
      if (pause) await pause();
      return [{ account_feeder_config: snapshot }];
    }
    if (text.includes("update noelle.agent_instances")) {
      state.current = state.stored = values[0] as Record<string, unknown>;
      return [];
    }
    if (text.includes("set_config")) return [];
    throw new Error("Unexpected style fixture SQL");
  }, { json: (value: unknown) => value,
    begin: (work: (sql: ReturnType<typeof query>) => Promise<unknown>) => transaction(() => work(query(true))),
    end: async () => { state.closed++; },
  });
}
vi.mock("postgres", () => ({ default: () => { state.opened++; return query(); } }));
import { pinnedVegaStyleConfig, vegaStylePin, vegaStyleUnpin } from "./vega-style.js";
const args = { dbUrl: "fixture", orgSlug: "fixture" };
let tails: Promise<unknown>[] = [];
function holdFirstRead() {
  let admitted!: () => void, release!: () => void, second!: () => void;
  const first = new Promise<void>(done => { admitted = done; });
  const held = new Promise<void>(done => { release = done; });
  const next = new Promise<void>(done => { second = done; });
  state.releaseRead = release; state.second = second;
  state.read = async () => { admitted(); await held; };
  return { first, release, next };
}
function own<T>(tail: Promise<T>): Promise<T> { tails.push(tail); void tail.catch(() => {}); return tail; }
beforeEach(() => {
  Object.assign(state, { current: {}, stored: null, found: true, opened: 0, closed: 0,
    txReads: [], releaseRead: null, read: null, second: null, tail: Promise.resolve() });
  tails = [];
});
afterEach(async () => {
  state.releaseRead?.(); await Promise.allSettled(tails); await state.tail;
  expect(state.closed).toBe(state.opened);
});

describe("persisted Vega style config", () => {
  it("retains implicit faithful-reply corpus selection and the saved voice rotation", async () => {
    state.current = { pinnedStyleHandle: "voice", faithfulVoices: ["first", "second"], faithfulVoiceWeights: [2, 1] };
    expect(await vegaStyleUnpin(args)).toEqual({ found: true });
    expect(state.stored).toMatchObject({ faithfulVoices: ["first", "second"], faithfulVoiceWeights: [2, 1] });
    expect(state.stored).not.toHaveProperty("pinnedStyleHandle");
    expect(state.stored).not.toHaveProperty("styleExemplarKinds");
  });
  it("preserves an explicit corpus selection while removing only the pin", async () => {
    state.current = { pinnedStyleHandle: "voice", styleExemplarKinds: ["comment"] };
    await vegaStyleUnpin(args);
    expect(state.stored).toHaveProperty("styleExemplarKinds", ["comment"]);
    expect(state.stored).not.toHaveProperty("pinnedStyleHandle");
  });
  it("retains another pin's selection knobs when unpin overlaps it", async () => {
    state.current = { pinnedStyleHandle: "old", maxStyleExemplars: 1, varietyTemperature: 0.4 };
    const held = holdFirstRead(), unpin = own(vegaStyleUnpin(args));
    await held.first;
    const pin = own(vegaStylePin({ ...args, handle: "new" }));
    await held.next; held.release(); await Promise.all([unpin, pin]);
    expect(state.current).toMatchObject({ maxStyleExemplars: 6, varietyTemperature: 0 });
  });
  it("retains a disjoint current config edit while pinning", async () => {
    state.current = { minPerformancePercentile: 10, faithfulVoices: ["first"] };
    const held = holdFirstRead(), pin = own(vegaStylePin({ ...args, handle: "new" }));
    await held.first;
    const edit = own(transaction(async () => {
      state.current = { ...(state.current as Record<string, unknown>), minPerformancePercentile: 88,
        faithfulVoices: ["second"], faithfulVoiceWeights: [3], styleExemplarKinds: ["comment"] };
    }));
    state.second?.(); await held.next; held.release(); await Promise.all([pin, edit]);
    expect(state.current).toMatchObject({ minPerformancePercentile: 88, faithfulVoices: ["second"],
      faithfulVoiceWeights: [3], styleExemplarKinds: ["comment"] });
  });
  it("uses the current pure transform and retains an implicit corpus choice", async () => {
    state.current = { maxStyleExemplars: 9, faithfulVoices: ["first"] };
    const expected = pinnedVegaStyleConfig(state.current, "@NewVoice");
    await vegaStylePin({ ...args, handle: "@NewVoice" });
    expect(state.stored).toEqual(expected);
    expect(state.stored).not.toHaveProperty("styleExemplarKinds");
  });
  it("keeps strict unknown-key rejection and closes without writing", async () => {
    state.current = { unknownKey: "operator value" };
    await expect(vegaStylePin({ ...args, handle: "voice" })).rejects.toThrow();
    await expect(vegaStyleUnpin(args)).rejects.toThrow();
    expect(state.current).toEqual({ unknownKey: "operator value" }); expect(state.stored).toBeNull();
  });
  it("keeps a null unpin as a no-op and an absent instance as not found", async () => {
    state.current = null; expect(await vegaStyleUnpin(args)).toEqual({ found: true });
    expect(state.stored).toBeNull(); state.found = false;
    expect(await vegaStylePin({ ...args, handle: "voice" })).toEqual({ found: false });
    expect(await vegaStyleUnpin(args)).toEqual({ found: false });
    expect(state.stored).toBeNull();
  });
});

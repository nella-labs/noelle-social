import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { vegaStylePin, vegaStyleUnpin } from "./vega-style.js";

const target = "noelle_vega_style_config_test";
const dbUrl = process.env.NOELLE_VEGA_STYLE_TEST_DATABASE_URL;
if (dbUrl) {
  const url = new URL(dbUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== `/${target}`
    || !url.username || url.search || url.hash) throw new Error("Exact dedicated local Vega test database required");
}
const state = vi.hoisted(() => ({ pools: new Set<Sql>(), pause: null as null | (() => Promise<void>) }));
vi.mock("postgres", async importOriginal => {
  const original = await importOriginal<{ default: typeof postgres }>();
  function wrap(sql: Sql): Sql {
    return new Proxy(sql, {
      apply: async (query, thisArg, values) => {
        const rows = await Reflect.apply(query, thisArg, values);
        const text = (values[0] as TemplateStringsArray).join(" ");
        if (text.includes("select account_feeder_config") && state.pause) {
          const pause = state.pause; state.pause = null; await pause();
        }
        return rows;
      },
      get: (query, key) => {
        if (key === "begin") return (work: (tx: Sql) => Promise<unknown>) => query.begin(tx => work(wrap(tx as unknown as Sql)));
        if (key === "end") return async (options: { timeout?: number }) => {
          await query.end(options); state.pools.delete(query);
        };
        return Reflect.get(query, key);
      },
    });
  }
  return { ...original, default: (url: string, options: postgres.Options<Record<string, postgres.PostgresType>>) => {
    const sql = original.default(url, { ...options, connection: { ...options.connection, application_name: "vega_style_native_cli" } });
    state.pools.add(sql); return wrap(sql);
  } };
});
const org = "00000000-0000-4000-8000-000000000001";
const instance = "00000000-0000-4000-8000-000000000011";
let admin: Sql, observer: Sql;
let releases: Array<() => void> = [], tails: Promise<unknown>[] = [];
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function own<T>(tail: Promise<T>): Promise<T> { tails.push(tail); void tail.catch(() => {}); return tail; }
async function within<T>(tail: Promise<T>, ms = 4000): Promise<T> {
  const controller = new AbortController();
  try {
    return await Promise.race([tail, delay(ms, null, { signal: controller.signal }).then(() => { throw new Error("Native fixture watchdog"); })]);
  } finally { controller.abort(); }
}
function pauseRead() {
  const admitted = gate(), release = gate(); releases.push(release.resolve);
  state.pause = async () => { admitted.resolve(); await release.promise; };
  return { admitted: admitted.promise, release: release.resolve };
}
async function seed(config: unknown) {
  await admin`update noelle.agent_instances set account_feeder_config=${admin.json(config as postgres.JSONValue)} where id=${instance}`;
}
async function current() {
  const rows = await admin<{ account_feeder_config: Record<string, unknown> | null }[]>`
    select account_feeder_config from noelle.agent_instances where id=${instance}`;
  return rows[0]!.account_feeder_config;
}
async function writerPhase(tail: Promise<unknown>): Promise<"completed" | "blocked"> {
  let settled = false;
  void tail.then(() => { settled = true; }, () => { settled = true; });
  const until = Date.now() + 1500;
  while (Date.now() < until) {
    if (settled) return "completed";
    const rows = await observer<{ blocked: boolean }[]>`
      select exists(select 1 from pg_stat_activity where datname=${target}
        and wait_event_type='Lock' and query ilike '%agent_instances%') as blocked`;
    if (rows[0]!.blocked) return "blocked";
    await delay(10);
  }
  throw new Error("Native writer neither completed nor blocked");
}

describe.skipIf(!dbUrl)("native Vega style config", () => {
  beforeAll(async () => {
    const original = await vi.importActual<{ default: typeof postgres }>("postgres");
    admin = original.default(dbUrl!, { max: 4, ssl: false, connect_timeout: 3, onnotice: () => {},
      connection: { application_name: "vega_style_fixture", statement_timeout: 10000, idle_in_transaction_session_timeout: 10000 } });
    observer = original.default(dbUrl!, { database: "postgres", max: 1, ssl: false, connect_timeout: 3, onnotice: () => {} });
    const db = await admin<{ current_database: string }[]>`select current_database()`;
    expect(db[0]!.current_database).toBe(target);
    await admin.unsafe("drop schema if exists noelle cascade");
    for (const name of ["0001_noelle_schema.sql", "0051_account_feeder.sql"])
      await admin.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    releases = []; tails = []; state.pause = null;
    expect((await admin<{ current_database: string }[]>`select current_database()`)[0]!.current_database).toBe(target);
    await admin`truncate noelle.organizations cascade`;
    await admin`insert into noelle.organizations(id,slug,name) values(${org},'fixture','Fixture')`;
    await admin`insert into noelle.agent_instances(id,org_id,role,status) values(${instance},${org},'x_intern','active')`;
  });
  afterEach(async () => {
    releases.forEach(release => release()); await Promise.allSettled(tails);
    await Promise.all([...state.pools].map(pool => pool.end({ timeout: 1 })));
    state.pools.clear(); state.pause = null;
  });
  afterAll(async () => {
    await Promise.allSettled(tails);
    await Promise.all([...state.pools].map(pool => pool.end({ timeout: 1 })));
    await admin?.end({ timeout: 1 });
    try {
      if (observer) {
        const rows = await observer<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where datname=${target}`;
        expect(rows[0]!.n).toBe(0);
      }
    } finally { await observer?.end({ timeout: 1 }); }
  });
  const args = { dbUrl: dbUrl!, orgSlug: "fixture" };
  it("retains actual pin tuning when another unpin overlaps", async () => {
    await seed({ pinnedStyleHandle: "old", maxStyleExemplars: 1, varietyTemperature: 0.4 });
    const held = pauseRead(), unpin = own(vegaStyleUnpin(args)); await within(held.admitted);
    const pin = own(vegaStylePin({ ...args, handle: "new" })); const phase = await writerPhase(pin);
    held.release(); await Promise.all([unpin, pin]);
    const config = await current(); console.info("native pin/unpin writer", phase, config);
    expect(config).toMatchObject({ maxStyleExemplars: 6, varietyTemperature: 0 });
    expect(phase).toBe("blocked");
  });
  it("retains a disjoint native key update while pinning", async () => {
    await seed({ minPerformancePercentile: 10, faithfulVoices: ["first"] });
    const held = pauseRead(), pin = own(vegaStylePin({ ...args, handle: "new" })); await within(held.admitted);
    const edit = own(admin`update noelle.agent_instances set account_feeder_config=account_feeder_config
      || ${admin.json({ minPerformancePercentile: 88, faithfulVoices: ["second"], faithfulVoiceWeights: [3], styleExemplarKinds: ["comment"] })}::jsonb
      where id=${instance}`.then(rows => rows));
    const phase = await writerPhase(edit); held.release(); await Promise.all([pin, edit]);
    const config = await current(); console.info("native disjoint writer", phase, config);
    expect(config).toMatchObject({ minPerformancePercentile: 88, faithfulVoices: ["second"], faithfulVoiceWeights: [3], styleExemplarKinds: ["comment"] });
    expect(phase).toBe("blocked");
  });
  it("preserves implicit corpus and faithful voice weights through pin and unpin", async () => {
    await seed({ faithfulVoices: ["first", "second"], faithfulVoiceWeights: [2, 1] });
    await vegaStylePin({ ...args, handle: "@NewVoice" }); await vegaStyleUnpin(args);
    expect(await current()).toMatchObject({ maxStyleExemplars: 6, varietyTemperature: 0, faithfulVoices: ["first", "second"], faithfulVoiceWeights: [2, 1] });
    expect(await current()).not.toHaveProperty("styleExemplarKinds");
    expect(await current()).not.toHaveProperty("pinnedStyleHandle");
  });
  it("preserves explicit corpus and all selection knobs while unpinning", async () => {
    await seed({ pinnedStyleHandle: "voice", maxStyleExemplars: 12, varietyTemperature: 0.25, styleExemplarKinds: ["comment"] });
    await vegaStyleUnpin(args);
    expect(await current()).toMatchObject({ maxStyleExemplars: 12, varietyTemperature: 0.25, styleExemplarKinds: ["comment"] });
  });
  it("retains strict unknown-key rejection without mutating the stored object", async () => {
    await seed({ unknownKey: "operator data" });
    await expect(vegaStylePin({ ...args, handle: "voice" })).rejects.toThrow();
    await expect(vegaStyleUnpin(args)).rejects.toThrow();
    expect(await current()).toEqual({ unknownKey: "operator data" });
  });
  it("keeps a null unpin as a no-op and an absent org as not found", async () => {
    await seed(null); expect(await vegaStyleUnpin(args)).toEqual({ found: true }); expect(await current()).toBeNull();
    expect(await vegaStylePin({ ...args, orgSlug: "absent", handle: "voice" })).toEqual({ found: false });
  });
  it("bounds a held row lock and allows a later recovery", async () => {
    await seed({ maxStyleExemplars: 2 });
    const locked = gate(), release = gate(); releases.push(release.resolve);
    const locker = own(admin.begin(async tx => {
      await tx`select id from noelle.agent_instances where id=${instance} for update`;
      locked.resolve(); await release.promise;
    }));
    await within(locked.promise);
    const pin = own(vegaStylePin({ ...args, handle: "voice" }));
    expect(await writerPhase(pin)).toBe("blocked");
    let failure: unknown;
    try { await within(pin, 3500); } catch (error) { failure = error; }
    finally { release.resolve(); await locker; await Promise.allSettled([pin]); }
    expect(failure).toMatchObject({ code: "55P03" });
    expect(await current()).toEqual({ maxStyleExemplars: 2 });
    expect(await vegaStylePin({ ...args, handle: "recovered" })).toEqual({ found: true });
    expect(await current()).toMatchObject({ pinnedStyleHandle: "recovered", maxStyleExemplars: 6 });
  });
});

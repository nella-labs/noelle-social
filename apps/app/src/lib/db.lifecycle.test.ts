import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  builds: [] as { close: ReturnType<typeof vi.fn>; resolve: () => void; stream: ReturnType<typeof vi.fn> }[],
  clients: [] as { query: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; begin: ReturnType<typeof vi.fn>; socket?: () => unknown }[],
  stalledFirstBuild: false,
  failFirstLocal: false,
  factoryAttempts: 0,
  authCalls: 0,
  dispatches: 0,
  query: (_text: string): Promise<unknown> => Promise.resolve([{ ok: true }]),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-vercel-oidc-token": "fixture-oidc" }) }));
vi.mock("google-auth-library", () => ({ ExternalAccountClient: { fromJSON: () => { state.authCalls += 1; return {}; } }, GoogleAuth: class {} }));
vi.mock("@google-cloud/cloud-sql-connector", () => ({
  IpAddressTypes: { PUBLIC: "PUBLIC" }, AuthTypes: { IAM: "IAM" },
  Connector: class {
    close = vi.fn();
    getOptions() {
      let resolve!: () => void;
      const stream = vi.fn();
      const pending = new Promise<{ stream: () => void }>((done) => { resolve = () => done({ stream }); });
      state.builds.push({ close: this.close, resolve, stream });
      if (!state.stalledFirstBuild || state.builds.length > 1) resolve();
      return pending;
    }
  },
}));
vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof import("postgres") }>("postgres");
  return { default: (options?: { socket?: () => unknown }) => {
  state.factoryAttempts += 1;
  if (state.failFirstLocal && state.factoryAttempts === 1) throw Object.assign(new Error("fixture acquisition failed"), { code: "ECONNREFUSED" });
  const native = actual.default("postgres://localhost/fixture");
  const query = vi.fn();
  const tagged = (strings: TemplateStringsArray, ...args: never[]) => {
    query(strings);
    const pending = Reflect.apply(native, undefined, [strings, ...args]);
    if (Array.isArray(strings.raw)) {
      pending.handler = () => {
        state.dispatches += 1;
        return Promise.resolve(state.query(strings.join("?"))).then(pending.resolve, pending.reject);
      };
    }
    return pending;
  };
  const end = vi.fn(async () => { await native.end({ timeout: 0 }); });
  const begin = vi.fn(async (fn: () => unknown) => fn());
  state.clients.push({ query, end, begin, socket: options?.socket });
  return Object.assign(tagged, native, { end, begin, unsafe: (text: string) => tagged(Object.assign([text], { raw: [text] }) as TemplateStringsArray), file: (path: string) => tagged(Object.assign([path], { raw: [path] }) as TemplateStringsArray) });
  } };
});

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  state.builds = []; state.clients = []; state.stalledFirstBuild = false;
  state.failFirstLocal = false; state.factoryAttempts = 0; state.authCalls = 0; state.dispatches = 0;
  state.query = () => Promise.resolve([{ ok: true }]);
  globalThis.__noelleSql = undefined; globalThis.__noelleConnector = undefined;
  vi.stubEnv("NOELLE_DATABASE_URL", "postgres://localhost/fixture?sslmode=disable");
  for (const key of ["NOELLE_GCP_PROJECT_NUMBER", "NOELLE_GCP_POOL_ID", "NOELLE_GCP_PROVIDER_ID", "NOELLE_GCP_SA_EMAIL", "NOELLE_CLOUDSQL_INSTANCE"]) vi.stubEnv(key, "");
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs();
  globalThis.__noelleSql = undefined; globalThis.__noelleConnector = undefined;
});

describe("database generation and dispatched deadlines", () => {
  it("does not retain a synchronously rejected acquisition promise", async () => {
    state.failFirstLocal = true;
    const { withTx } = await import("./db");
    const request = withTx(async () => true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await request).toBe(true);
    expect(state.factoryAttempts).toBe(2);
  });
  it("disposes a late unpublished build without replacing or closing its healthy successor", async () => {
    state.stalledFirstBuild = true;
    for (const key of ["NOELLE_GCP_PROJECT_NUMBER", "NOELLE_GCP_POOL_ID", "NOELLE_GCP_PROVIDER_ID", "NOELLE_GCP_SA_EMAIL", "NOELLE_CLOUDSQL_INSTANCE"]) vi.stubEnv(key, "fixture");
    const { sql } = await import("./db");
    const request = sql`select 1`.then((rows) => rows);
    await vi.advanceTimersByTimeAsync(9250);
    expect(await request).toEqual([{ ok: true }]);
    expect(state.builds).toHaveLength(2);
    expect(state.builds[0]!.close).toHaveBeenCalledOnce();
    expect(state.clients).toHaveLength(1);
    const healthy = state.clients[0]!;
    state.builds[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.clients).toHaveLength(1);
    expect(healthy.end).not.toHaveBeenCalled();
    expect(state.builds[1]!.close).not.toHaveBeenCalled();
    await sql`select 2`;
    expect(healthy.query).toHaveBeenCalledTimes(2);
    healthy.socket!();
    expect(state.builds[0]!.stream).not.toHaveBeenCalled();
    expect(state.builds[1]!.stream).toHaveBeenCalledOnce();
  });
  it("cold helper/query construction does no auth, socket or dispatch work", async () => {
    for (const key of ["NOELLE_GCP_PROJECT_NUMBER", "NOELLE_GCP_POOL_ID", "NOELLE_GCP_PROVIDER_ID", "NOELLE_GCP_SA_EMAIL", "NOELLE_CLOUDSQL_INSTANCE"]) vi.stubEnv(key, "fixture");
    const { sql } = await import("./db");
    sql.json({ value: 1 }); sql("value"); sql([1, 2]);
    const pending = sql`select 1`.simple();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.clients).toHaveLength(1);
    expect(state.authCalls).toBe(0);
    expect(state.builds).toHaveLength(0);
    expect(state.dispatches).toBe(0);
    expect(pending.execute()).toBe(pending);
    expect(await pending).toEqual([{ ok: true }]);
    expect(state.authCalls).toBe(1);
    expect(state.dispatches).toBe(1);
    expect(state.clients[0]!.end).not.toHaveBeenCalled();
  });
  it.each(["unsafe", "file"] as const)("cold %s waits for WIF preparation and keeps one bounded dispatch", async (method) => {
    state.stalledFirstBuild = true;
    for (const key of ["NOELLE_GCP_PROJECT_NUMBER", "NOELLE_GCP_POOL_ID", "NOELLE_GCP_PROVIDER_ID", "NOELLE_GCP_SA_EMAIL", "NOELLE_CLOUDSQL_INSTANCE"]) vi.stubEnv(key, "fixture");
    const { sql } = await import("./db");
    const pending = (method === "file" ? sql.file("select 1") : sql.unsafe("select 1")).simple();
    expect(state.authCalls).toBe(0);
    const result = pending.then((rows) => rows);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.dispatches).toBe(0);
    state.builds[0]!.resolve();
    expect(await result).toEqual([{ ok: true }]);
    expect(state.dispatches).toBe(1);
    expect(state.clients).toHaveLength(1);
  });
  it.each(["unsafe", "file"] as const)("%s deadline never replays or acknowledges a late result", async (method) => {
    let finish!: () => void;
    state.query = () => new Promise((resolve) => { finish = () => resolve([{ late: true }]); });
    const { sql } = await import("./db");
    const pending = method === "file" ? sql.file("select 1") : sql.unsafe("select 1");
    const result = pending.then(() => true, (error: { name: string }) => error.name);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await result).toBe("DbTimeoutError");
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe("DbTimeoutError");
    expect(state.dispatches).toBe(1);
    expect(state.clients[0]!.end).not.toHaveBeenCalled();
  });
  it("a dispatched deadline never replays, closes another request, or acknowledges a late result", async () => {
    let finish!: () => void;
    state.query = (text) => text.includes("slow") ? new Promise((resolve) => { finish = () => resolve([{ late: true }]); }) : Promise.resolve([{ fast: true }]);
    const { sql } = await import("./db");
    const slow = sql`select 'slow'`.then(() => ({ ok: true }), (error: { name: string }) => ({ ok: false, name: error.name }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await sql`select 'fast'`).toEqual([{ fast: true }]);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await slow).toEqual({ ok: false, name: "DbTimeoutError" });
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(await slow).toEqual({ ok: false, name: "DbTimeoutError" });
    expect(state.clients[0]!.query).toHaveBeenCalledTimes(2);
    expect(state.clients[0]!.end).not.toHaveBeenCalled();
  });
  it("withTx does not replay a callback after a lost committed result", async () => {
    const { withTx } = await import("./db");
    const callback = vi.fn(async () => { throw Object.assign(new Error("fixture result lost"), { code: "ECONNRESET" }); });
    await expect(withTx(callback)).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(callback).toHaveBeenCalledOnce();
    expect(state.clients[0]!.end).not.toHaveBeenCalled();
  });
  it("a transaction deadline does not replay its callback or acknowledge a late commit", async () => {
    let finish!: () => void;
    const callback = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { withTx, sql } = await import("./db");
    const result = withTx(callback).then(() => ({ ok: true }), (error: { name: string }) => ({ ok: false, name: error.name }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await sql`select 1`).toEqual([{ ok: true }]);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await result).toEqual({ ok: false, name: "DbTimeoutError" });
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(await result).toEqual({ ok: false, name: "DbTimeoutError" });
    expect(callback).toHaveBeenCalledOnce();
    expect(state.clients[0]!.end).not.toHaveBeenCalled();
  });
});

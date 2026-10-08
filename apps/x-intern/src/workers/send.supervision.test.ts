import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ActiveInstance } from "../lib/activation.js";

const state = vi.hoisted(() => ({
  onTick: null as null | ((inst: ActiveInstance) => Promise<void>),
  pause: "success" as "success" | "error" | "no-row",
  outcome: "locked" as "locked" | "uncertain" | "auth_failed" | "reply_forbidden" | "rate_limited",
  tokens: true,
  notify: vi.fn(),
  halt: vi.fn(),
  tick: vi.fn(),
  finish: vi.fn(),
  log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../env.js", () => ({
  loadEnv: () => ({
    WORKER_ID: "inert",
    GCP_PROJECT: "inert",
    X_PERSIST_SEND_COOLDOWN: false,
    AUTOSEND_QUIET_START_UTC: 0,
    AUTOSEND_QUIET_END_UTC: 0,
    NOELLE_AUTOSEND_INTERSEND_FLOOR: false,
    NOELLE_AUTOSEND_BLOCK_EXTERNAL_LINKS: false,
  }),
}));
vi.mock("../lib/logger.js", () => ({ createLogger: () => state.log }));
vi.mock("../lib/db.js", () => ({
  noelleDb: () => async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("count(*)")) return [{ retry: 1, stamped: 0 }];
    return [{ cap: 30 }];
  },
}));
vi.mock("../lib/activation.js", () => ({
  listSendXInternInstances: async () => [{ id: "instance", org_id: "org" }],
  isWorkerEnabled: (inst: ActiveInstance) => inst.send_enabled !== false,
}));
vi.mock("../lib/boot.js", () => ({ runBootChecks: async () => ({ ok: true }), EX_TEMPFAIL: 75 }));
vi.mock("../lib/bus.js", () => ({ busForInstance: () => ({}) }));
vi.mock("../lib/secrets.js", () => ({ createSecretsClient: () => ({}) }));
vi.mock("../lib/worker-runs.js", () => ({ recordRun: async () => ({ finish: state.finish }) }));
vi.mock("@noelle/runtime/notifier", async (original) => ({
  ...(await original<object>()),
  createNotifier: () => ({ notify: state.notify }),
}));
vi.mock("./_runtime.js", () => ({
  installShutdown: () => () => false,
  runWorkerLoop: async (args: {
    listActive: () => Promise<ActiveInstance[]>;
    onTick: (inst: ActiveInstance) => Promise<void>;
  }) => {
    await args.listActive();
    state.onTick = args.onTick;
  },
}));
vi.mock("../lib/x-api-tokens.js", () => ({
  readXApiTokens: async () =>
    state.tokens ? { accessToken: "inert", authKind: "oauth2", consumerKey: "inert" } : null,
  saveRefreshedXApiTokens: vi.fn(),
}));
vi.mock("../lib/x-api-send-client.js", () => ({ createXApiSendClient: () => ({}) }));
vi.mock("../lib/send-db.js", () => ({
  listRetrySendDue: async () => [
    { draft_id: "draft", in_reply_to_id: "post", body: "a concrete reply" },
  ],
  claimAutoSendDue: async () => [],
  releaseAutoSendRowsForReview: vi.fn(),
}));
vi.mock("./send-tick.js", () => ({ runSendTick: state.tick }));
vi.mock("../lib/send-halt-db.js", () => ({ haltXSend: state.halt }));
const instance = { id: "instance", org_id: "org", send_enabled: true, reply_send_enabled: true };
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  state.onTick = null;
  state.pause = "success";
  state.tokens = true;
  state.outcome = "locked";
  state.notify.mockResolvedValue({ status: "sent", channel: "pushover", request: "receipt" });
  state.halt.mockImplementation(async () => {
    if (state.pause === "error") throw new Error("database unavailable");
    return state.pause === "success";
  });
  state.tick.mockImplementation(async () => [
    { draftId: "draft", status: state.outcome, reason: "fixture" },
  ]);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-06T12:00:00Z"));
  await import("./send.js");
  await vi.waitFor(() => expect(state.onTick).not.toBeNull());
});
afterEach(() => vi.restoreAllMocks());
it("reports a committed reply-send halt", async () => {
  await state.onTick!(instance);
  expect(state.tick).toHaveBeenCalledOnce();
  expect(state.notify).toHaveBeenCalledWith(
    expect.objectContaining({ title: expect.stringContaining("DISABLED") }),
  );
});
it.each(["error", "no-row"] as const)(
  "does not claim disabled sends when halt persistence gives %s",
  async (pause) => {
    state.pause = pause;
    await state.onTick!(instance);
    expect(state.tick).toHaveBeenCalledOnce();
    expect(state.notify).toHaveBeenCalledOnce();
    const notification = state.notify.mock.calls[0]![0];
    expect(`${notification.title} ${notification.message}`).not.toMatch(/DISABLED|now OFF/);
  },
);
it("does not claim paused sends when uncertain-write halt persistence fails", async () => {
  state.pause = "error";
  state.outcome = "uncertain";
  await state.onTick!(instance);
  expect(state.notify).toHaveBeenCalledOnce();
  expect(state.notify.mock.calls[0]![0].title).not.toMatch(/sends paused/);
});
it.each(["auth_failed", "reply_forbidden", "rate_limited"] as const)(
  "preserves the %s alert producer",
  async (status) => {
    state.outcome = status;
    await state.onTick!(instance);
    expect(state.notify).toHaveBeenCalledOnce();
    expect(state.halt).not.toHaveBeenCalled();
  },
);
it("keeps the missing-writer alert's six-hour accepted receipt interval", async () => {
  state.tokens = false;
  await state.onTick!(instance);
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-10-06T17:59:00Z"));
  await state.onTick!(instance);
  expect(state.notify).toHaveBeenCalledOnce();
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-10-06T18:00:00Z"));
  await state.onTick!(instance);
  expect(state.notify).toHaveBeenCalledTimes(2);
  expect(state.tick).not.toHaveBeenCalled();
});
it.each(["send_enabled", "reply_send_enabled"])("keeps the %s consent gate", async (flag) => {
  await state.onTick!({ ...instance, [flag]: false });
  expect(state.tick).not.toHaveBeenCalled();
  expect(state.notify).not.toHaveBeenCalled();
});

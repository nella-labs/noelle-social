import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ActiveInstance } from "../lib/activation.js";
import type { PublishOutcome } from "./content-publish-tick.js";

const state = vi.hoisted(() => ({
  onTick: null as null | ((inst: ActiveInstance) => Promise<void>),
  tokens: true,
  writeEnabled: true,
  pause: "success" as "success" | "error" | "no-row",
  metricsEnabled: true,
  outcomes: [] as PublishOutcome[],
  notify: vi.fn(),
  halt: vi.fn(),
  metrics: vi.fn(),
  log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../env.js", () => ({
  loadEnv: () => ({
    WORKER_ID: "inert",
    GCP_PROJECT: "inert",
    NOELLE_MEDIA_BACKEND: "local",
    NOELLE_X_METRICS: state.metricsEnabled,
    NOELLE_X_METRICS_MS: 3 * 60 * 60_000,
    NOELLE_X_SELF_TRACK_WINDOW_DAYS: 7,
    NOELLE_X_SELF_TRACK_MAX: 10,
  }),
}));
vi.mock("../lib/logger.js", () => ({ createLogger: () => state.log }));
vi.mock("../lib/db.js", () => ({
  noelleDb: () => async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("select x_api_write_enabled"))
      return [{ x_api_write_enabled: state.writeEnabled, x_api_daily_write_cap: 30 }];
    return [];
  },
}));
vi.mock("../lib/activation.js", () => ({
  listSendXInternInstances: async () => [{ id: "instance", org_id: "org" }],
  isWorkerEnabled: (inst: ActiveInstance) => inst.send_enabled !== false,
}));
vi.mock("../lib/boot.js", () => ({ runBootChecks: async () => ({ ok: true }) }));
vi.mock("../lib/secrets.js", () => ({ createSecretsClient: () => ({}) }));
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
  readXApiTokens: async () => (state.tokens ? {} : null),
}));
vi.mock("../lib/x-api-client-factory.js", () => ({
  buildXApiClient: async () => ({ getTweetMetrics: vi.fn() }),
}));
vi.mock("./content-publish-tick.js", () => ({ runContentPublishTick: async () => state.outcomes }));
vi.mock("./content-metrics-tick.js", () => ({ runContentMetricsTick: state.metrics }));

vi.mock("../lib/send-halt-db.js", () => ({ haltXSend: state.halt }));
const at = Date.parse("2026-10-06T12:00:00Z");
const instance = { id: "instance", org_id: "org", send_enabled: true };
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  state.onTick = null;
  state.tokens = true;
  state.writeEnabled = true;
  state.pause = "success";
  state.metricsEnabled = true;
  state.outcomes = [];
  state.notify.mockResolvedValue({ status: "sent", channel: "pushover", request: "receipt" });
  state.halt.mockImplementation(async () => {
    if (state.pause === "error") throw new Error("database unavailable");
    return state.pause === "success";
  });
  state.metrics.mockResolvedValue({ postsConsidered: 0, measured: 0 });
  vi.spyOn(Date, "now").mockReturnValue(at);
  await import("./content-publish.js");
  await vi.waitFor(() => expect(state.onTick).not.toBeNull());
});
afterEach(() => vi.restoreAllMocks());
it("reports a committed account halt", async () => {
  state.outcomes = [{ slotId: "slot", status: "locked" }];
  await state.onTick!(instance);
  expect(state.notify).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Vega posting halted" }),
  );
});
it.each(["error", "no-row"] as const)(
  "does not report a saved halt when the pause UPDATE gives %s",
  async (pause) => {
    state.pause = pause;
    state.outcomes = [{ slotId: "slot", status: "locked" }];
    await state.onTick!(instance);
    expect(state.halt).toHaveBeenCalledWith(expect.anything(), {
      orgId: "org",
      instanceId: "instance",
    });
    expect(state.notify).toHaveBeenCalledOnce();
    const notification = state.notify.mock.calls[0]![0];
    expect(`${notification.title} ${notification.message}`).not.toMatch(
      /posting halted|flipped off/,
    );
  },
);
it("retries an attempted failed metrics sweep at the documented next interval", async () => {
  state.metrics.mockRejectedValueOnce(new Error("read failed"));
  await state.onTick!(instance);
  vi.mocked(Date.now).mockReturnValue(at + 60_000);
  await state.onTick!(instance);
  expect(state.metrics).toHaveBeenCalledOnce();
  vi.mocked(Date.now).mockReturnValue(at + 3 * 60 * 60_000);
  await state.onTick!(instance);
  expect(state.metrics).toHaveBeenCalledTimes(2);
});
it("documents that a skipped no-reader metrics call consumes the current cadence", async () => {
  state.tokens = false;
  await state.onTick!(instance);
  expect(state.metrics).toHaveBeenCalledWith(expect.objectContaining({ reader: null }));
  state.tokens = true;
  vi.mocked(Date.now).mockReturnValue(at + 60_000);
  await state.onTick!(instance);
  expect(state.metrics).toHaveBeenCalledOnce();
});
it("preserves the explicit metrics-off gate", async () => {
  state.metricsEnabled = false;
  vi.resetModules();
  state.onTick = null;
  await import("./content-publish.js");
  await vi.waitFor(() => expect(state.onTick).not.toBeNull());
  await state.onTick!(instance);
  expect(state.metrics).not.toHaveBeenCalled();
});
it("does not suppress a failed halt alert on the next still-enabled worker tick", async () => {
  state.pause = "error";
  state.outcomes = [{ slotId: "slot", status: "locked" }];
  state.notify.mockResolvedValueOnce({ status: "error", channel: "pushover", detail: "rejected" });
  await state.onTick!(instance);
  vi.mocked(Date.now).mockReturnValue(at + 60_000);
  await state.onTick!(instance);
  expect(state.notify).toHaveBeenCalledTimes(2);
});
it.each<PublishOutcome>([
  { slotId: "slot", status: "failed", failurePhase: "draft_load", claimRetained: true },
  { slotId: "slot", status: "uncertain", reconciliationPersisted: true },
  { slotId: "slot", status: "duplicate", reconciliationPersisted: false },
])("preserves recovery alerts for $status outcomes", async (outcome) => {
  state.outcomes = [outcome];
  await state.onTick!(instance);
  expect(state.notify).toHaveBeenCalledOnce();
  expect(state.halt).not.toHaveBeenCalled();
});
it.each(["send", "write"])(
  "preserves the %s consent gate without alerts or metrics",
  async (gate) => {
    state.outcomes = [{ slotId: "slot", status: "locked" }];
    state.writeEnabled = gate !== "write";
    await state.onTick!({ ...instance, send_enabled: gate !== "send" });
    expect(state.notify).not.toHaveBeenCalled();
    expect(state.halt).not.toHaveBeenCalled();
    expect(state.metrics).not.toHaveBeenCalled();
  },
);

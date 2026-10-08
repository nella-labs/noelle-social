import { describe, expect, it, vi } from "vitest";
import type { ActiveInstance } from "./activation.js";
import { isRelationshipDmsLaneEnabled, runRelationshipDmsForInstance } from "./relationship-dms.js";

const base: ActiveInstance = {
  id: "inst-li",
  org_id: "org-1",
  status: "active",
};

const runner = {
  draft: vi.fn(async () => ({ text: "{}", engine: "test", model: "test" })),
};
const log = { info: vi.fn(), error: vi.fn() };
const postOutbound = vi.fn(async () => null);

describe("isRelationshipDmsLaneEnabled", () => {
  it("defaults off", () => {
    expect(isRelationshipDmsLaneEnabled(base)).toBe(false);
  });

  it("requires the relationship DM lane flag", () => {
    expect(
      isRelationshipDmsLaneEnabled({
        ...base,
        lane_config: { dms: { relationship_dms_enabled: true } },
      }),
    ).toBe(true);
  });

  it("runs while active or paused, including during reply goal runs", () => {
    const laneOn = { dms: { relationship_dms_enabled: true } };
    expect(isRelationshipDmsLaneEnabled({ ...base, status: "paused", lane_config: laneOn })).toBe(true);
    expect(
      isRelationshipDmsLaneEnabled({ ...base, status: "provisioning", lane_config: laneOn }),
    ).toBe(false);
    expect(isRelationshipDmsLaneEnabled({ ...base, status: undefined, lane_config: laneOn })).toBe(
      false,
    );
    const goalRun: ActiveInstance = {
        ...base,
        lane_config: laneOn,
        goal_target: 40,
        goal_started_at: "2026-09-14T00:00:00.000Z",
    };
    expect(isRelationshipDmsLaneEnabled(goalRun)).toBe(true);
  });
});

describe("runRelationshipDmsForInstance", () => {
  it("does not call the shared tick when the lane is off", async () => {
    const tick = vi.fn(async () => 1);
    const hasPending = vi.fn(async () => false);
    const n = await runRelationshipDmsForInstance({
      sql: vi.fn() as never,
      instance: base,
      runner,
      postOutbound,
      log,
      runRelationshipDmTick: tick,
      hasPendingRelationshipDmRequests: hasPending,
    });
    expect(n).toBe(0);
    expect(hasPending).toHaveBeenCalledWith(expect.any(Function), {
      orgId: "org-1",
      instanceId: "inst-li",
      platform: "linkedin",
    });
    expect(tick).not.toHaveBeenCalled();
  });

  it("drains requested DMs while recurring friendly DMs are off", async () => {
    const tick = vi.fn(async () => 1);
    const n = await runRelationshipDmsForInstance({
      sql: vi.fn() as never,
      instance: { ...base, status: "paused" },
      runner,
      postOutbound,
      log,
      runRelationshipDmTick: tick,
      hasPendingRelationshipDmRequests: vi.fn(async () => true),
    });
    expect(n).toBe(1);
    expect(tick).toHaveBeenCalledWith(expect.objectContaining({ includeRecurring: false }));
  });

  it("calls the shared tick for active LinkedIn instances without relying on reply toggles", async () => {
    const tick = vi.fn(async () => 2);
    const n = await runRelationshipDmsForInstance({
      sql: vi.fn() as never,
      instance: {
        ...base,
        drafter_enabled: false,
        dm_autodraft_enabled: false,
        linkedin_intro_dm_enabled: false,
        lane_config: { dms: { relationship_dms_enabled: true } },
      },
      runner,
      postOutbound,
      log,
      runRelationshipDmTick: tick,
    });

    expect(n).toBe(2);
    expect(tick).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        instanceId: "inst-li",
        platform: "linkedin",
        postOutbound,
        routing: expect.objectContaining({
          primary: expect.objectContaining({ engine: "bedrock" }),
        }),
      }),
    );
  });

  it("calls the shared tick for paused LinkedIn instances during a reply goal run", async () => {
    const tick = vi.fn(async () => 2);
    const n = await runRelationshipDmsForInstance({
      sql: vi.fn() as never,
      instance: {
        ...base,
        status: "paused",
        drafter_enabled: false,
        dm_autodraft_enabled: false,
        linkedin_intro_dm_enabled: false,
        watchlist_enabled: false,
        lane_config: { dms: { relationship_dms_enabled: true } },
        goal_target: 40,
        goal_started_at: "2026-09-14T00:00:00.000Z",
      },
      runner,
      postOutbound,
      log,
      runRelationshipDmTick: tick,
    });

    expect(n).toBe(2);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});

import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import {
  XAuthError,
  XChallengeError,
  XDuplicateError,
  XLockError,
  XRateLimitError,
  XWriteUncertainError,
  type XWriteClient,
} from "@noelle/x-client";
import { runContentPublishTick } from "./content-publish-tick.js";

const receipt = { id: "123", url: "https://x.com/operator/status/123" };

function fixture(
  options: {
    writeFailure?: Error;
    persistFailures?: number;
    mediaFailure?: boolean;
    draftFailure?: boolean;
    budgetFailure?: boolean;
    restoreFailure?: boolean;
    receiptRowMissing?: boolean;
    quarantineRowMissing?: boolean;
  } = {},
) {
  const state = {
    status: "ready",
    used: 0,
    postedUrl: null as string | null,
    postedId: null as string | null,
    attempts: 0,
  };
  let persistFailures = options.persistFailures ?? 0;
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("select role,status,send_enabled"))
      return Promise.resolve([
        { role: "x_intern", status: "active", send_enabled: true, x_api_write_enabled: true },
      ]);
    if (query.includes("select s.id,s.draft_id,d.idea_id"))
      return Promise.resolve(
        state.status === "ready" ? [{ id: "slot", draft_id: "draft", idea_id: "idea" }] : [],
      );
    if (query.includes("select id from noelle.post_ideas"))
      return Promise.resolve([{ id: "idea" }]);
    if (
      query.includes("select id from noelle.content_schedule_slots") &&
      query.includes("and draft_id=")
    )
      return Promise.resolve([{ id: "slot" }]);
    if (query.includes("set status = 'publishing'")) {
      if (state.status !== "ready") return Promise.resolve([]);
      state.status = "publishing";
      return Promise.resolve([{ id: "slot", draft_id: "draft", idea_id: "idea" }]);
    }
    if (query.includes("select body, final_body") || query.includes("select body,final_body")) {
      if (options.draftFailure && query.includes("select body, final_body"))
        return Promise.reject(new Error("draft lookup failed"));
      return Promise.resolve([{ body: "a supported post", final_body: null }]);
    }
    if (query.includes("insert into noelle.x_api_write_budget")) {
      state.used++;
      if (options.budgetFailure) return Promise.reject(new Error("reservation response lost"));
      return Promise.resolve([{ used: state.used }]);
    }
    if (query.includes("update noelle.x_api_write_budget")) {
      state.used--;
      return Promise.resolve([]);
    }
    if (query.includes("from noelle.content_media")) {
      if (options.mediaFailure) return Promise.reject(new Error("media lookup failed"));
      return Promise.resolve([]);
    }
    if (query.includes("set status='published'")) {
      if (persistFailures-- > 0) return Promise.reject(new Error("receipt database write failed"));
      if (options.receiptRowMissing) return Promise.resolve([]);
      state.status = "published";
      state.postedUrl = values[0] as string;
      state.postedId = values[1] as string;
      return Promise.resolve([{ id: "slot" }]);
    }
    if (query.includes("set status='failed'")) {
      if (persistFailures-- > 0)
        return Promise.reject(new Error("quarantine database write failed"));
      if (options.quarantineRowMissing) return Promise.resolve([]);
      state.status = "failed";
      if (query.includes("posted_url=coalesce")) {
        state.postedUrl = values[0] as string | null;
        state.postedId = values[1] as string | null;
      }
      return Promise.resolve([{ id: "slot" }]);
    }
    if (query.includes("set status='ready'")) {
      if (options.restoreFailure) return Promise.reject(new Error("claim restoration failed"));
      state.status = "ready";
      return Promise.resolve([{ id: "slot" }]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;
  sql.begin = (async (callback: (tx: Sql) => Promise<unknown>) =>
    callback(sql)) as unknown as typeof sql.begin;
  const client = {
    postTweet: async () => {
      state.attempts++;
      if (options.writeFailure) throw options.writeFailure;
      return receipt;
    },
  } as unknown as XWriteClient;
  const args = { sql, instanceId: "instance", orgId: "org", cap: 30, minSpacingMs: 0, client };
  return { state, args };
}

describe("content publish uncertain receipts", () => {
  it("quarantines transport ambiguity without returning the reservation or retrying", async () => {
    const { state, args } = fixture({ writeFailure: new XWriteUncertainError("response lost") });
    expect(await runContentPublishTick(args)).toEqual([
      { slotId: "slot", status: "uncertain", reconciliationPersisted: true },
    ]);
    expect(state).toMatchObject({ status: "failed", used: 1, postedUrl: null, attempts: 1 });
    expect(await runContentPublishTick(args)).toEqual([]);
    expect(state.attempts).toBe(1);
  });

  it("retains a supplied uncertain receipt for reconciliation", async () => {
    const { state, args } = fixture({
      writeFailure: new XWriteUncertainError("receipt needs reconciliation", receipt),
    });
    expect(await runContentPublishTick(args)).toEqual([
      { slotId: "slot", status: "uncertain", receipt, reconciliationPersisted: true },
    ]);
    expect(state).toMatchObject({
      status: "failed",
      used: 1,
      postedUrl: receipt.url,
      postedId: receipt.id,
    });
  });

  it("quarantines a confirmed post when receipt persistence fails", async () => {
    const { state, args } = fixture({ persistFailures: 1 });
    expect(await runContentPublishTick(args)).toEqual([
      { slotId: "slot", status: "uncertain", receipt, reconciliationPersisted: true },
    ]);
    expect(state).toMatchObject({
      status: "failed",
      used: 1,
      postedUrl: receipt.url,
      postedId: receipt.id,
      attempts: 1,
    });
  });

  it("retains the claim and receipt when both persistence writes fail", async () => {
    const { state, args } = fixture({ persistFailures: 2 });
    expect(await runContentPublishTick(args)).toEqual([
      { slotId: "slot", status: "uncertain", receipt, reconciliationPersisted: false },
    ]);
    expect(state).toMatchObject({ status: "publishing", used: 1, attempts: 1 });
    expect(await runContentPublishTick(args)).toEqual([]);
  });

  it("treats an unclassified error after dispatch as uncertain", async () => {
    const { state, args } = fixture({ writeFailure: new Error("socket reset") });
    expect((await runContentPublishTick(args))[0]?.status).toBe("uncertain");
    expect(state).toMatchObject({ status: "failed", used: 1 });
  });

  it("holds a duplicate rejection without claiming publication or consuming the write budget", async () => {
    const { state, args } = fixture({ writeFailure: new XDuplicateError() });
    expect(await runContentPublishTick(args)).toEqual([
      { slotId: "slot", status: "duplicate", reconciliationPersisted: true },
    ]);
    expect(state).toMatchObject({
      status: "failed",
      used: 0,
      postedUrl: null,
      postedId: null,
      attempts: 1,
    });
    expect(await runContentPublishTick(args)).toEqual([]);
    expect(state.attempts).toBe(1);
  });

  it("reports duplicate hold persistence failure while retaining the claim and releasing the budget", async () => {
    const { state, args } = fixture({ writeFailure: new XDuplicateError(), persistFailures: 1 });
    expect(await runContentPublishTick(args)).toEqual([
      { slotId: "slot", status: "duplicate", reconciliationPersisted: false },
    ]);
    expect(state).toMatchObject({ status: "publishing", used: 0, postedUrl: null, postedId: null });
    expect(await runContentPublishTick(args)).toEqual([]);
  });

  it.each([false, true])(
    "recovers a draft read failure and reports restoration failure=%s",
    async (restoreFailure) => {
      const { state, args } = fixture({ draftFailure: true, restoreFailure });
      expect(await runContentPublishTick(args)).toEqual([
        {
          slotId: "slot",
          status: "failed",
          failurePhase: "draft_load",
          claimRetained: restoreFailure,
          budgetReservationUncertain: false,
        },
      ]);
      expect(state).toMatchObject({
        status: restoreFailure ? "publishing" : "ready",
        used: 0,
        attempts: 0,
      });
    },
  );

  it.each([false, true])(
    "recovers a lost reservation response without undercounting and reports restoration failure=%s",
    async (restoreFailure) => {
      const { state, args } = fixture({ budgetFailure: true, restoreFailure });
      expect(await runContentPublishTick(args)).toEqual([
        {
          slotId: "slot",
          status: "failed",
          failurePhase: "budget_reservation",
          claimRetained: restoreFailure,
          budgetReservationUncertain: true,
        },
      ]);
      expect(state).toMatchObject({
        status: restoreFailure ? "publishing" : "ready",
        used: 1,
        attempts: 0,
      });
    },
  );

  it.each([
    [new XAuthError(), "failed"],
    [new XLockError(), "locked"],
    [new XChallengeError(), "challenged"],
    [new XRateLimitError(), "rate_limited"],
  ])(
    "releases known rejection %s without changing the account stop outcome",
    async (writeFailure, status) => {
      const { state, args } = fixture({ writeFailure: writeFailure as Error });
      expect((await runContentPublishTick(args))[0]?.status).toBe(status);
      expect(state).toMatchObject({ status: "ready", used: 0 });
    },
  );

  it("keeps a pre-dispatch media failure retryable", async () => {
    const { state, args } = fixture({ mediaFailure: true });
    expect((await runContentPublishTick(args))[0]?.status).toBe("failed");
    expect(state).toMatchObject({ status: "ready", used: 0, attempts: 0 });
  });
  it.each([false, true])(
    "does not claim publication when the receipt update touches no row; quarantine absent=%s",
    async (quarantineRowMissing) => {
      const { state, args } = fixture({ receiptRowMissing: true, quarantineRowMissing });
      expect(await runContentPublishTick(args)).toEqual([
        {
          slotId: "slot",
          status: "uncertain",
          receipt,
          reconciliationPersisted: !quarantineRowMissing,
        },
      ]);
      expect(state).toMatchObject({
        status: quarantineRowMissing ? "publishing" : "failed",
        used: 1,
        attempts: 1,
      });
      expect(await runContentPublishTick(args)).toEqual([]);
    },
  );
});

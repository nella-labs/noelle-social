import { XRateLimitError, XWritePreparationError, isDefiniteXWriteRejection, type XClient, type XTweet, type XWriteClient } from "@noelle/x-client";
import { reserveXApiWrite, releaseXApiWrite } from "./x-api-budget.js";

/**
 * Adapt an official X API write client (OAuth 1.0a OR OAuth 2.0 — the caller
 * builds it via createXApiClient and passes it in) to the worker `XClient`
 * interface the send worker + runSendTick expect. Autonomous auto-send replies
 * post through this instead of the stale `@steipete/bird` cookies. Only
 * createTweet + verifyCredentials are exercised by the send worker.
 *
 * Every reply reserves from the SAME daily X-API write budget as content-publish
 * (the combined cap); a cap hit surfaces as XRateLimitError → the worker backs
 * off and retries next tick (idempotent on sent_external_id), never exceeding it.
 */
export function createXApiSendClient(args: {
  sql: Parameters<typeof reserveXApiWrite>[0];
  agentInstanceId: string;
  orgId: string;
  cap: number;
  handle: string | null;
  /** Pre-built write client — createXApiClient({ oauth1a }) OR ({ tokens, clientId, ... }). */
  write: XWriteClient;
}): XClient {
  return {
    // Creds were validated at connect time. The write client is post-only, so
    // return the known handle without an extra call; a bad cred surfaces as
    // XAuthError on the first postTweet (→ the worker's auth_failed handling).
    async verifyCredentials() {
      return { screen_name: args.handle ?? "", id_str: "" };
    },
    async createTweet({ inReplyToId, text }) {
      // Combined daily X-API cap shared with content-publish. Reserve BEFORE
      // posting; release only after a definite rejection. An uncertain write
      // may already be live and still consumes the budget.
      const reservation = await reserveXApiWrite(args.sql, {
        agentInstanceId: args.agentInstanceId,
        orgId: args.orgId,
        cap: args.cap,
      }).catch(() => { throw new XWritePreparationError("write-budget reservation failed before dispatch; budget may remain charged"); });
      if (!reservation) throw new XRateLimitError("daily X API write cap reached");
      try {
        return await args.write.postTweet({ text, inReplyToId });
      } catch (err) {
        if (isDefiniteXWriteRejection(err)) {
          await releaseXApiWrite(args.sql, reservation).catch(() => {});
        }
        throw err;
      }
    },
    // The send worker never calls these; keep them inert + safe.
    async likeTweet() {
      return false;
    },
    async userTweets(): Promise<XTweet[]> {
      return [];
    },
    async searchTimeline(): Promise<XTweet[]> {
      return [];
    },
  };
}

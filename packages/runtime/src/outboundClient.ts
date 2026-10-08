// HMAC-signed outbound ingestion; the reviewed final body is signed once.

import { OutboundCreatedSchema, OutboundInSchema, OutboundOwnerSchema, type OutboundIn } from "@noelle/contracts";
import { typoRateFromEnv } from "./humanTypos.js";
import { polishReplyBody } from "./replyPolish.js";
import { signContentRequest } from "./contentPush.js";
import { decodeHttpJson, fetchBoundedHttpResponse } from "./boundedHttp.js";

export interface OutboundClient {
  postOutbound(body: OutboundIn, owner?: NonNullable<OutboundIn["owner"]>): Promise<{ id: string; approval_id: string }>;
}

function bindOutboundOwner(body: OutboundIn, owner?: NonNullable<OutboundIn["owner"]>): OutboundIn {
  if (!owner) return body;
  const schema = OutboundOwnerSchema;
  const scoped = schema.parse(owner);
  if (body.owner) {
    const supplied = schema.parse(body.owner);
    if (supplied.orgId.toLowerCase() !== scoped.orgId.toLowerCase()
      || supplied.agentInstanceId.toLowerCase() !== scoped.agentInstanceId.toLowerCase())
      throw new Error("Outbound owner does not match the current agent instance.");
    return body;
  }
  return { ...body, owner: scoped };
}

/**
 * REPLY POLISH. Every draft from every intern crosses this client exactly once,
 * on its way to the approval queue, which makes it the one place the pass
 * belongs: no intern can forget to call it and no draft gets it twice.
 *
 * Two transforms, in `polishReplyBody` (see replyPolish.ts): strip
 * sentence-ending full stops, then apply at most one human typing slip.
 *
 * Deliberately placed HERE and not in the drafters, for two reasons beyond
 * dedup. It runs AFTER the verifier and the reply-diversity gate, so a graded
 * draft is never penalised for a slip we introduced on purpose. And it runs
 * BEFORE the approval row is written, so the operator reviews the exact text
 * that will be posted, typo included, instead of approving clean copy and
 * having it mutate on send.
 *
 * Replies only. A DM is a cold first touch, written as flowing prose, and
 * neither transform belongs there, so `kind === 'dm'` (and 'repost') passes
 * through untouched. `charCount` is recomputed off the final body so the inbox
 * count matches what ships.
 */
function applyReplyPolish(body: OutboundIn, typoRate: number): OutboundIn {
  let changed = false;
  const drafts = body.drafts.map((d) => {
    if (d.kind !== "reply") return d;
    const out = polishReplyBody(d.body, { platform: body.platform, typoRate });
    if (out.body === d.body) return d;
    changed = true;
    return { ...d, body: out.body, charCount: [...out.body].length };
  });
  return changed ? { ...body, drafts } : body;
}

export function createOutboundClient(opts: {
  baseUrl: string;
  hmacSecret: string;
  fetchImpl?: typeof fetch;
  /** Request deadline, including the response body. Default 8 seconds. */
  timeoutMs?: number;
  /**
   * Share of REPLY drafts that receive one deliberate typing slip. Omitted =>
   * read from the environment on every post (NOELLE_HUMAN_TYPOS /
   * NOELLE_HUMAN_TYPO_RATE, default 18%), so the rate can be retuned without a
   * redeploy. Pass 0 to disable the SLIP for a caller; tests pass an explicit
   * rate. It does not disable the full-stop strip, which is a hard voice rule
   * rather than a probabilistic flourish.
   */
  typoRate?: number;
}): OutboundClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const typoRate = () => opts.typoRate ?? typoRateFromEnv();
  return {
    async postOutbound(body, owner) {
      const bound = bindOutboundOwner(body, owner);
      // No full stops, plus one believable slip on ~typoRate of replies
      // (default 18%), so the feed does not read as machine-perfect.
      const parsed = OutboundInSchema.parse(applyReplyPolish(bound, typoRate()));
      const json = JSON.stringify(parsed);
      const { timestamp, signature } = signContentRequest(opts.hmacSecret, json, Math.floor(Date.now() / 1000));
      const { response: res, bytes } = await fetchBoundedHttpResponse(`${opts.baseUrl}/api/outbound`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-noelle-timestamp": timestamp,
          "x-noelle-signature": signature,
        },
        body: json,
      }, { fetchImpl, timeoutMs: opts.timeoutMs ?? 8000, maxBytes: 65_536 });
      if (!res.ok) {
        throw new Error(`POST /api/outbound ${res.status}`);
      }
      try { return OutboundCreatedSchema.parse(decodeHttpJson(bytes)); }
      catch { throw new Error("POST /api/outbound returned an invalid receipt"); }
    },
  };
}

import type { Sql } from "postgres";
import type { InboundReplyIn, InboundReplyResult } from "@noelle/contracts";
import { conversationKeyFor } from "./notification-replies.js";

/** Serialize a bounded notification batch with its queued conversation turns. */
export async function queueNotificationReplies(sql: Sql, args: {
  orgId: string; body: InboundReplyIn; maxTurns: number;
}): Promise<InboundReplyResult[] | null> {
  const { orgId, body, maxTurns } = args;
  return sql.begin(async tx => {
    await tx`set local lock_timeout='5s'`;
    await tx`set local statement_timeout='10s'`;
    const [owner] = await tx`
      select id from noelle.agent_instances
      where id=${body.instanceId} and org_id=${orgId}
        and role=${body.platform === "x" ? "x_intern" : "linkedin_intern"}
      for update
    `;
    if (!owner) return null;
    const results: InboundReplyResult[] = [];
    for (const item of body.items) {
      const [existing] = await tx`select id from noelle.leads
        where org_id=${orgId} and platform=${body.platform} and external_id=${item.external_id} limit 1`;
      if (existing) {
        results.push({ external_id: item.external_id, accepted: false, reason: "duplicate" });
        continue;
      }
      const key = conversationKeyFor(item);
      const [turns] = await tx<{ n: number }[]>`
        select count(*)::int as n from noelle.leads
        where org_id=${orgId} and agent_instance_id=${body.instanceId} and platform=${body.platform}
          and payload->>'source'='notification'
          and case when payload->>'conversation_key' like 'author:%'
            then 'author:'||lower(ltrim(substring(payload->>'conversation_key' from 8),'@'))
            else payload->>'conversation_key' end=${key}
      `;
      const prior = turns?.n ?? Number.POSITIVE_INFINITY;
      if (prior >= maxTurns) {
        results.push({ external_id: item.external_id, accepted: false, reason: "turn-cap" });
        continue;
      }
      const payload = { text: item.text, url: item.url, posted_at: item.posted_at,
        source: "notification", conversation_key: key, prior_turns: prior,
        ...(item.conversation ? { conversation: item.conversation } : {}) };
      const inserted = await tx`insert into noelle.leads
        (org_id,agent_instance_id,external_id,platform,author_handle,author_id,payload,status,priority)
        values (${orgId},${body.instanceId},${item.external_id},${body.platform},${item.author_handle},
          ${item.author_id ?? null},${tx.json(payload)},'classified',true)
        on conflict (org_id,platform,external_id) do nothing returning id`;
      results.push({ external_id: item.external_id, accepted: inserted.length > 0,
        ...(inserted.length ? {} : { reason: "duplicate" as const }) });
    }
    return results;
  }) as Promise<InboundReplyResult[] | null>;
}

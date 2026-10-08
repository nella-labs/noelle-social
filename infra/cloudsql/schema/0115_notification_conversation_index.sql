-- Conversation turn checks include legacy author keys with leading @ signs.
-- Build outside a transaction to preserve availability of notification writers.
create index concurrently if not exists leads_notification_conversation_idx
  on noelle.leads (org_id, agent_instance_id, platform,
    (case when payload->>'conversation_key' like 'author:%'
      then 'author:'||lower(ltrim(substring(payload->>'conversation_key' from 8),'@'))
      else payload->>'conversation_key' end))
  where payload->>'source'='notification';

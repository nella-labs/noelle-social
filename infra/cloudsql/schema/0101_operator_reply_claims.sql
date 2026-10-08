-- infra/cloudsql/schema/0101_operator_reply_claims.sql
-- Keep explicit MCP/operator reply requests out of ordinary reply claim RPCs.
--
-- noelle_generate_reply-style requests mark classified leads with
-- payload.reply_requested=true and are claimed by the dedicated per-worker
-- request claimer, which forces human/reviewer handling from payload.reply_request.
-- The ordinary regular/watchlist/notification RPCs must not steal those rows and
-- draft them as normal replies first.

create or replace function noelle.apply_reply_requested_exclusion(
  p_signature regprocedure,
  p_anchor text,
  p_predicate text
)
returns void
language plpgsql
as $$
declare
  def text;
begin
  select pg_get_functiondef(p_signature::oid) into def;
  if def is null then
    raise exception 'function % not found', p_signature;
  end if;

  if position(p_predicate in def) > 0 then
    return;
  end if;

  if position(p_anchor in def) = 0 then
    raise exception 'function % did not match expected claim predicate anchor', p_signature;
  end if;

  execute replace(def, p_anchor, p_anchor || E'\n        ' || p_predicate);
end;
$$;

select noelle.apply_reply_requested_exclusion(
  'noelle.claim_leads_for_drafting(uuid,integer,integer)'::regprocedure,
  'and priority = false',
  'and coalesce(payload->>''reply_requested'', ''false'') <> ''true'''
);

select noelle.apply_reply_requested_exclusion(
  'noelle.claim_watchlist_leads_for_drafting(uuid,integer,integer)'::regprocedure,
  'and cand.priority = true',
  'and coalesce(cand.payload->>''reply_requested'', ''false'') <> ''true'''
);

select noelle.apply_reply_requested_exclusion(
  'noelle.claim_notification_leads_for_drafting(uuid,integer)'::regprocedure,
  'and coalesce(l.payload->>''source'', '''') = ''notification''',
  'and coalesce(l.payload->>''reply_requested'', ''false'') <> ''true'''
);

drop function noelle.apply_reply_requested_exclusion(regprocedure, text, text);

grant execute on function noelle.claim_leads_for_drafting(uuid, integer, integer) to noelle_app;
grant execute on function noelle.claim_watchlist_leads_for_drafting(uuid, integer, integer) to noelle_app;
grant execute on function noelle.claim_notification_leads_for_drafting(uuid, integer) to noelle_app;

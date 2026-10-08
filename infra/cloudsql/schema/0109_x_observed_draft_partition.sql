-- Browser observations are claimed by x-intern's strict Jev/force-review lane.
-- The shared ordinary RPCs must never claim one first. Keep their ordering,
-- age limits, reply-request exclusion, and pending-author guard unchanged.

create or replace function noelle.apply_x_observed_exclusion(
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

select noelle.apply_x_observed_exclusion(
  'noelle.claim_leads_for_drafting(uuid,integer,integer)'::regprocedure,
  'and priority = false',
  'and coalesce(payload->>''source'', '''') <> ''extension_observed'''
);

select noelle.apply_x_observed_exclusion(
  'noelle.claim_watchlist_leads_for_drafting(uuid,integer,integer)'::regprocedure,
  'and cand.priority = true',
  'and coalesce(cand.payload->>''source'', '''') <> ''extension_observed'''
);

drop function noelle.apply_x_observed_exclusion(regprocedure, text, text);

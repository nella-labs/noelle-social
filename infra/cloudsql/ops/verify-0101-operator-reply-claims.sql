-- Run against a scratch database after applying 0101_operator_reply_claims.sql.
-- The transaction rolls back, so it leaves no temporary leads behind.

begin;

do $$
declare
  v_org_id uuid;
  v_agent_instance_id uuid;
  v_suffix text := replace(gen_random_uuid()::text, '-', '');
  v_claimed text[];
  v_explicit text[];
begin
  select o.id, ai.id
    into v_org_id, v_agent_instance_id
    from noelle.organizations o
    join noelle.agent_instances ai on ai.org_id = o.id and ai.role = 'linkedin_intern'
   order by o.created_at, o.id, ai.created_at, ai.id
   limit 1;

  if v_org_id is null or v_agent_instance_id is null then
    raise exception 'scratch verifier requires an organization with a linkedin_intern instance';
  end if;

  -- Regular claim: must draft ordinary non-priority leads and leave explicit
  -- operator reply requests for the dedicated request claimer.
  insert into noelle.leads
    (org_id, agent_instance_id, external_id, platform, author_handle, author_id, payload,
     status, priority, classifier_label, classifier_score, tier)
  values
    (v_org_id, v_agent_instance_id, 'scratch-0101-regular-ok-' || v_suffix, 'linkedin', 'claim-regular-ok-' || v_suffix, null,
     jsonb_build_object('text', 'regular ok', 'posted_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
     'classified', false, 'reply', 0.95, 'T1'),
    (v_org_id, v_agent_instance_id, 'scratch-0101-regular-requested-' || v_suffix, 'linkedin', 'claim-regular-requested-' || v_suffix, null,
     jsonb_build_object('text', 'regular requested', 'posted_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
       'reply_requested', true, 'reply_request', jsonb_build_object('request_key', 'regular-request-' || v_suffix)),
     'classified', false, 'reply', 0.95, 'T1');

  select coalesce(array_agg(external_id order by external_id), '{}')
    into v_claimed
    from noelle.claim_leads_for_drafting(v_agent_instance_id, 10, 24)
   where external_id like 'scratch-0101-regular-%-' || v_suffix;
  if v_claimed <> array['scratch-0101-regular-ok-' || v_suffix] then
    raise exception 'regular claim stole or missed rows: %', v_claimed;
  end if;

  with explicit_claim as (
    update noelle.leads l
       set status = 'drafting', payload = payload - 'reply_requested', updated_at = now()
     where l.id in (
       select c.id
         from noelle.leads c
        where c.agent_instance_id = v_agent_instance_id
          and c.status = 'classified'
          and c.payload->>'reply_requested' = 'true'
          and c.payload->'reply_request'->>'request_key' is not null
          and c.external_id like 'scratch-0101-regular-%-' || v_suffix
        order by c.updated_at desc
        limit 10
        for update skip locked
     )
    returning external_id
  )
  select coalesce(array_agg(external_id order by external_id), '{}') into v_explicit from explicit_claim;
  if v_explicit <> array['scratch-0101-regular-requested-' || v_suffix] then
    raise exception 'explicit regular request claim failed: %', v_explicit;
  end if;

  -- Watchlist claim: same exclusion, but through the priority/watchlist RPC.
  insert into noelle.leads
    (org_id, agent_instance_id, external_id, platform, author_handle, author_id, payload,
     status, priority, classifier_label, classifier_score, tier)
  values
    (v_org_id, v_agent_instance_id, 'scratch-0101-watch-ok-' || v_suffix, 'linkedin', 'claim-watch-ok-' || v_suffix, null,
     jsonb_build_object('text', 'watch ok', 'posted_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
     'classified', true, 'reply', 0.95, 'T1'),
    (v_org_id, v_agent_instance_id, 'scratch-0101-watch-requested-' || v_suffix, 'linkedin', 'claim-watch-requested-' || v_suffix, null,
     jsonb_build_object('text', 'watch requested', 'posted_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
       'reply_requested', true, 'reply_request', jsonb_build_object('request_key', 'watch-request-' || v_suffix)),
     'classified', true, 'reply', 0.95, 'T1');

  select coalesce(array_agg(external_id order by external_id), '{}')
    into v_claimed
    from noelle.claim_watchlist_leads_for_drafting(v_agent_instance_id, 10, 24)
   where external_id like 'scratch-0101-watch-%-' || v_suffix;
  if v_claimed <> array['scratch-0101-watch-ok-' || v_suffix] then
    raise exception 'watchlist claim stole or missed rows: %', v_claimed;
  end if;

  with explicit_claim as (
    update noelle.leads l
       set status = 'drafting', payload = payload - 'reply_requested', updated_at = now()
     where l.id in (
       select c.id
         from noelle.leads c
        where c.agent_instance_id = v_agent_instance_id
          and c.status = 'classified'
          and c.payload->>'reply_requested' = 'true'
          and c.payload->'reply_request'->>'request_key' is not null
          and c.external_id like 'scratch-0101-watch-%-' || v_suffix
        order by c.updated_at desc
        limit 10
        for update skip locked
     )
    returning external_id
  )
  select coalesce(array_agg(external_id order by external_id), '{}') into v_explicit from explicit_claim;
  if v_explicit <> array['scratch-0101-watch-requested-' || v_suffix] then
    raise exception 'explicit watch request claim failed: %', v_explicit;
  end if;

  -- Notification claim: explicit operator requests should not be consumed by
  -- the ordinary notifications lane either.
  insert into noelle.leads
    (org_id, agent_instance_id, external_id, platform, author_handle, author_id, payload,
     status, priority, classifier_label, classifier_score, tier)
  values
    (v_org_id, v_agent_instance_id, 'scratch-0101-notification-ok-' || v_suffix, 'linkedin', 'claim-notification-ok-' || v_suffix, null,
     jsonb_build_object('text', 'notification ok', 'source', 'notification', 'posted_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
     'classified', true, 'reply', 0.95, 'T1'),
    (v_org_id, v_agent_instance_id, 'scratch-0101-notification-requested-' || v_suffix, 'linkedin', 'claim-notification-requested-' || v_suffix, null,
     jsonb_build_object('text', 'notification requested', 'source', 'notification', 'posted_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
       'reply_requested', true, 'reply_request', jsonb_build_object('request_key', 'notification-request-' || v_suffix)),
     'classified', true, 'reply', 0.95, 'T1');

  select coalesce(array_agg(external_id order by external_id), '{}')
    into v_claimed
    from noelle.claim_notification_leads_for_drafting(v_agent_instance_id, 10)
   where external_id like 'scratch-0101-notification-%-' || v_suffix;
  if v_claimed <> array['scratch-0101-notification-ok-' || v_suffix] then
    raise exception 'notification claim stole or missed rows: %', v_claimed;
  end if;

  with explicit_claim as (
    update noelle.leads l
       set status = 'drafting', payload = payload - 'reply_requested', updated_at = now()
     where l.id in (
       select c.id
         from noelle.leads c
        where c.agent_instance_id = v_agent_instance_id
          and c.status = 'classified'
          and c.payload->>'reply_requested' = 'true'
          and c.payload->'reply_request'->>'request_key' is not null
          and c.external_id like 'scratch-0101-notification-%-' || v_suffix
        order by c.updated_at desc
        limit 10
        for update skip locked
     )
    returning external_id
  )
  select coalesce(array_agg(external_id order by external_id), '{}') into v_explicit from explicit_claim;
  if v_explicit <> array['scratch-0101-notification-requested-' || v_suffix] then
    raise exception 'explicit notification request claim failed: %', v_explicit;
  end if;

  if exists (
    select 1 from noelle.leads
     where external_id like 'scratch-0101-%-' || v_suffix
       and payload ? 'reply_requested'
  ) then
    raise exception 'explicit request flag was not cleared after request claims';
  end if;

  raise notice '0101 verifier ok: ordinary RPCs excluded reply_requested leads; explicit claim retained them';
end $$;

rollback;

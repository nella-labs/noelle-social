-- Invalid saved dates remain unknown instead of aborting a whole claim batch.
create or replace function noelle.source_timestamp(value text)
returns timestamptz language sql stable strict as $$
  select case when value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
    and pg_input_is_valid(value, 'timestamp with time zone')
    then value::timestamptz end;
$$;

-- The notification window matches runtime/notificationWindow.ts.
create or replace function noelle.x_reply_is_fresh(payload jsonb, max_age_hours integer)
returns boolean language sql stable as $$
  select max_age_hours is null or max_age_hours <= 0
    or noelle.source_timestamp(payload->>'posted_at') is null
    or noelle.source_timestamp(payload->>'posted_at') >= now() - (
      case when payload->>'source' = 'notification' then interval '12 hours'
        else make_interval(hours => max_age_hours) end);
$$;

grant execute on function noelle.source_timestamp(text) to noelle_app;
grant execute on function noelle.x_reply_is_fresh(jsonb, integer) to noelle_app;

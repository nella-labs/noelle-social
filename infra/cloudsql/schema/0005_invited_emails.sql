-- noelle.invited_emails — sign-in allowlist + admin flag.
--
-- This table is the new single source of truth for:
--   1. Who is allowed to authenticate at all (any row).
--   2. Who is admin (`is_admin = true`).
--
-- Enforcement lives in apps/app:
--   - `/auth/gate` route handler checks `email` against this table after
--     Supabase issues a session; rejected users get their session cleared.
--   - `apps/app/src/lib/admin-gate.ts` reads `is_admin` for the current
--     session email instead of comparing against a hardcoded set.
--
-- Email is stored lowercase. Callers normalise via `lower(trim($1))`.

create table if not exists noelle.invited_emails (
  email           text        primary key,
  is_admin        boolean     not null default false,
  invited_by      uuid        null,
  created_at      timestamptz not null default now(),
  redeemed_at     timestamptz null,
  linked_user_id  uuid        null
);

comment on table noelle.invited_emails is
  'Sign-in allowlist for app.trynoelle.com. Membership in this table is required to authenticate; is_admin gates operator screens.';

-- Explicit grants — default privileges from 0003 only apply to tables
-- created by the SAME role that ran the `alter default privileges` step,
-- which we can't guarantee for ad-hoc migration runs.
grant select, insert, update on noelle.invited_emails
  to "vercel-noelle-app@noelle-agents.iam";

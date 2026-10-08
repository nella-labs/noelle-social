-- noelle.alpha_invitations — admin-managed alpha invitations.
--
-- Replaces the static NOELLE_ALPHA_INVITE_CODES env list with a DB-backed,
-- revocable, auditable invitation system that the admin panel manages.
--
-- Two kinds:
--   'email' — bound to a specific recipient. Creating one also upserts the
--             address into noelle.invited_emails so it passes the sign-in
--             gate (apps/app/src/app/auth/gate/route.ts), and an invite email
--             is sent via Listmonk/SES. The onboarding flow auto-recognises
--             the signed-in user's email and skips the code-entry step.
--   'code'  — a loose shareable code (e.g. constellation-ab12cd) not tied to
--             an email. Anyone who passes the sign-in gate can redeem it to
--             create an org.
--
-- Enforcement lives in apps/app:
--   - apps/app/src/lib/invitations.ts        — lookup + code generation
--   - apps/app/src/app/onboarding/actions.ts — redeem + redeemed stamping
--   - apps/app/src/app/app/[orgSlug]/admin/invitations/actions.ts — create/revoke
--
-- Email is stored lowercase. Callers normalise via lower(trim($1)).

create table if not exists noelle.alpha_invitations (
  id              uuid        primary key default gen_random_uuid(),
  code            text        not null unique,
  email           text        null,
  kind            text        not null default 'code'
                    check (kind in ('email', 'code')),
  status          text        not null default 'pending'
                    check (status in ('pending', 'redeemed', 'revoked')),
  note            text        null,
  created_by      uuid        null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz null,
  redeemed_at     timestamptz null,
  redeemed_by     uuid        null,
  redeemed_org_id uuid        null
);

comment on table noelle.alpha_invitations is
  'Admin-managed alpha invitations. kind=email is bound to a recipient (also seeded into invited_emails); kind=code is a loose shareable code. Redeemed at org creation during onboarding.';

-- Fast lookup of a pending email-bound invite for the signed-in user.
create index if not exists alpha_invitations_email_idx
  on noelle.alpha_invitations (lower(email))
  where email is not null;

create index if not exists alpha_invitations_status_idx
  on noelle.alpha_invitations (status);

-- Explicit grants — default privileges from 0003 only apply to tables
-- created by the SAME role that ran the `alter default privileges` step,
-- which we can't guarantee for ad-hoc migration runs. No delete: revoking an
-- invite is a status update, not a row removal (keeps the audit trail).
grant select, insert, update on noelle.alpha_invitations
  to "vercel-noelle-app@noelle-agents.iam";

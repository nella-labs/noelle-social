-- General Mars vault onboarding state. Tracks how far each org has
-- progressed through the Light → Medium → Rich wizard, and persists
-- the user's answers so resuming the wizard (or re-rendering files
-- after a template tweak) doesn't lose data.
--
-- See docs/vault.md and
-- docs/superpowers/specs/2026-05-26-general-mars-vault-design.md.

-- Add the stage column to noelle.vaults. Nullable: an org with no
-- wizard run yet has wizard_stage IS NULL. Nothing routes on that any
-- more -- the dashboard used to hard-redirect such orgs into the wizard,
-- but voice grounding is fail-open, so it is now the (optional) `voice`
-- step of the guided workflow. See docs/guided-workflow.md.
alter table noelle.vaults
  add column if not exists wizard_stage text;

alter table noelle.vaults
  drop constraint if exists vaults_wizard_stage_check;

alter table noelle.vaults
  add constraint vaults_wizard_stage_check
    check (wizard_stage is null or wizard_stage in ('light', 'medium', 'rich'));

-- Answers are stored loose in jsonb. The renderer tolerates missing
-- keys via defaults so a schema bump doesn't break older rows.
create table if not exists noelle.vault_wizard_answers (
  org_id            uuid primary key references noelle.organizations(id) on delete cascade,
  stage_completed   text not null,
  answers           jsonb not null default '{}'::jsonb,
  updated_at        timestamptz not null default now(),
  constraint vault_wizard_answers_stage_check
    check (stage_completed in ('light', 'medium', 'rich'))
);

drop trigger if exists vault_wizard_answers_set_updated_at on noelle.vault_wizard_answers;
create trigger vault_wizard_answers_set_updated_at
  before update on noelle.vault_wizard_answers
  for each row execute function noelle.tg_set_updated_at();

grant select, insert, update, delete on noelle.vault_wizard_answers to noelle_app;

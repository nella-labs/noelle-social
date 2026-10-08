-- Operator-set brand config for an agent instance: persona, product/offer,
-- pitch policy, reply + DM message styles, and brand Q&A. Externalises what
-- used to be hardcoded in the drafter's SYSTEM_X prompt so an operator can
-- tailor the agent to their own business without forking the prompt.
--
-- Shape is validated in app/worker code against BrandConfigSchema
-- (packages/contracts/src/brand-config.ts). Read fresh per drafter tick via
-- ActiveInstance, so dashboard/CLI edits take effect next cycle. Empty '{}'
-- (the default) reproduces the generic, product-agnostic peer behaviour.

alter table noelle.agent_instances
  add column if not exists brand_config jsonb not null default '{}'::jsonb;

comment on column noelle.agent_instances.brand_config is
  'Operator brand config (persona/product/pitch_policy/reply_style/dm_style/qa). Validated against BrandConfigSchema; composed into the drafter system prompt by renderBrandBlock().';

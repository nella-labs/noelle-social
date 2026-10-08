-- 0077_x_api_oauth1a.sql
--
-- Support OAuth 1.0a user-context creds (Consumer Key/Secret + Access
-- Token/Secret) on x_api_tokens, alongside the OAuth2 (Bearer + refresh) path.
-- 1.0a is what X's "Keys & Tokens" page hands out and is simplest for a single
-- operator: long-lived, no browser flow. `access_token` holds the 1.0a access
-- token; the new columns hold the rest. `auth_kind` selects the signing mode.
-- Hand-applied; grants inherited from 0001.
alter table noelle.x_api_tokens
  add column if not exists auth_kind           text not null default 'oauth2',  -- 'oauth1a' | 'oauth2'
  add column if not exists consumer_key        text,
  add column if not exists consumer_secret     text,
  add column if not exists access_token_secret text;

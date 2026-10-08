// Re-export the shared @noelle/secrets client. The Reddit intern (Orion) needs
// exactly one real credential — an Apify API token. There is no Reddit login and
// no Reddit cookie anywhere in this app: Apify runs the scraper and proxies it.
//
// Dual-source (identical to how the other interns read their credentials):
//   - managed: GCP Secret Manager id `apify-token`.
//   - self-host (NOELLE_SECRETS_SOURCE=env): env var NOELLE_SECRET_APIFY_TOKEN
//     (the secretIdToEnvKey() mapping of `apify-token`).

export {
  SecretAccessError,
  createSecretsClient,
  secretIdToEnvKey,
  type SecretsClient,
} from "@noelle/secrets";

/**
 * Apify API token — the credential for the posts transport (@noelle/reddit-apify),
 * which fetches a watched subreddit's posts with no Reddit cookies at all.
 *
 * This is the FALLBACK id: the pool resolver prefers the org's active
 * `noelle.connections` tokens (rotated live from the dashboard) and only calls
 * `secrets.get(APIFY_TOKEN_SECRET_ID)` when the org has none. Resolves GCP SM
 * `apify-token` (managed) or env `NOELLE_SECRET_APIFY_TOKEN` (self-host).
 */
export const APIFY_TOKEN_SECRET_ID = "apify-token";

// Re-export the shared @noelle/secrets client. The video intern (Nova) needs
// exactly one real credential — an Apify API token. There is no social login and
// no cookie anywhere in this app: Apify runs the clip scrapers and proxies them.
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
 * Apify API token — the credential for the clip transport (@noelle/video-apify),
 * which the harvester uses to pull the watchlist creators + niches.
 *
 * This is the FALLBACK id: the resolver in lib/apify-resolver.ts prefers the
 * org's active `noelle.connections` tokens and only calls
 * `secrets.get(APIFY_TOKEN_SECRET_ID)` when the org has none. Resolves GCP SM
 * `apify-token` (managed) or env `NOELLE_SECRET_APIFY_TOKEN` (self-host).
 */
export const APIFY_TOKEN_SECRET_ID = "apify-token";

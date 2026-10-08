// Re-export the shared @noelle/secrets client. The LinkedIn intern (Lyra) needs
// exactly one real credential — an Apify API token. No worker in this app reads a
// LinkedIn `li_at` cookie: posts and profiles come from Apify HarvestAPI, which
// authenticates with the Apify token alone.
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
 * Apify API token — the credential for the posts transport (@noelle/linkedin-apify).
 * Posts are fetched via Apify HarvestAPI, which needs NO LinkedIn cookies; the
 * Apify token is the only credential discovery/profiler require now.
 * Resolves GCP SM `apify-token` (managed) or env `NOELLE_SECRET_APIFY_TOKEN`
 * (self-host).
 */
export const APIFY_TOKEN_SECRET_ID = "apify-token";

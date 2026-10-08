// Moved to @noelle/secrets so apps/api-vm can read X cookies (and any
// future per-org secret) via the same TTL-cached client. Workers' existing
// imports of `./secrets.js` continue to work via this re-export.

export {
  SecretAccessError,
  createSecretsClient,
  type SecretsClient,
} from "@noelle/secrets";

/**
 * GCP Secret Manager id (managed) / env `NOELLE_SECRET_APIFY_TOKEN` (self-host)
 * fallback for the Apify API token used by X discovery + profiler reads. This is
 * the SAME shared 'apify' token the LinkedIn (Lyra) and Reddit (Orion) interns
 * use — the dashboard's per-org noelle.connections apify pool takes precedence
 * over this env/SM fallback (see lib/apify-resolver.ts).
 */
export const APIFY_TOKEN_SECRET_ID = "apify-token";

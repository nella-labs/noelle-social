import { headers } from "next/headers";
import {
  createSecretManagerClient,
  SecretManagerProcess,
  SecretAccessError,
  type SecretWifAuth,
} from "@noelle/secrets";

declare global {
  var __noelleSmProcess: SecretManagerProcess | undefined;
}
export const SM_PROJECT = process.env.NOELLE_GCP_PROJECT ?? "noelle-agents";

/** Bind the invocation header to one bounded sequence; authentication stays in the SDK child. */
export async function getSecretManagerClient() {
  const deadline = performance.now() + 8000;
  const owner = (globalThis.__noelleSmProcess ??= new SecretManagerProcess());
  owner.checkAvailable();
  const projectNumber = process.env.NOELLE_GCP_PROJECT_NUMBER;
  const poolId = process.env.NOELLE_GCP_POOL_ID;
  const providerId = process.env.NOELLE_GCP_PROVIDER_ID;
  const saEmail = process.env.NOELLE_GCP_SA_EMAIL;
  const configured = [projectNumber, poolId, providerId, saEmail];
  let wif: SecretWifAuth | undefined;
  if (configured.some(Boolean)) {
    if (!configured.every(Boolean))
      throw new SecretAccessError("Incomplete Secret Manager WIF configuration");
    const token = (await headers()).get("x-vercel-oidc-token");
    if (!token) throw new SecretAccessError("Secret Manager request identity is missing");
    wif = {
      audience: `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`,
      subjectToken: token,
      serviceAccountImpersonationUrl: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${saEmail}:generateAccessToken`,
    };
  }
  return createSecretManagerClient({
    owner,
    deadline,
    ...(wif ? { wif } : {}),
    sdkOptions: { projectId: SM_PROJECT },
  });
}

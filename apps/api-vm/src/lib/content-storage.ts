// Construct the content-media ContentStorage backend from env.
//   local (self-host): files under NOELLE_MEDIA_DIR, served same-origin by the
//     Next app at /media/<key> (the only Tailscale-published origin).
//   gcs (prod): bounded object HTTP, with canonical SDK URL signing.
import { createGcsSigner } from "@noelle/runtime/gcs-signer";
import {
  createLocalContentStorage,
  type ContentStorage,
} from "@noelle/runtime/content-storage";
import type { Env } from "../env.js";
import { createGcsMediaStorage } from "./gcs-content-storage.js";
import { createGoogleCredentialClient, type GoogleCredentialClient } from "@noelle/runtime/google-credentials";

export type MediaBackend = "local" | "gcs";
// GCS object access and IAM signing scopes used by the Storage SDK.
const GCS_AUTH_SCOPES = ["https://www.googleapis.com/auth/iam", "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/devstorage.full_control"];

/** Pure backend selector — testable without touching disk/GCS. */
export function selectMediaBackend(env: Pick<Env, "NOELLE_MEDIA_BACKEND" | "NOELLE_MEDIA_BUCKET">): MediaBackend {
  if (env.NOELLE_MEDIA_BACKEND === "gcs") {
    if (!env.NOELLE_MEDIA_BUCKET) {
      throw new Error("NOELLE_MEDIA_BACKEND=gcs requires NOELLE_MEDIA_BUCKET");
    }
    return "gcs";
  }
  return "local";
}

let cached: ContentStorage | undefined;
let credentialClient: GoogleCredentialClient | undefined;

export function getContentStorage(env: Env): ContentStorage {
  if (cached) return cached;
  const backend = selectMediaBackend(env);
  if (backend === "local") {
    cached = createLocalContentStorage({
      dir: env.NOELLE_MEDIA_DIR,
      publicBaseUrl: env.NOELLE_MEDIA_PUBLIC_BASE_URL,
    });
    return cached;
  }
  // prod: GCS. Keep the bucket PRIVATE and hand out V4 signed read URLs — a
  // public URL would either 404 (private bucket) or leak every org's media to
  // the world (public bucket). Read consumers mint a fresh transferable URL;
  // each V4 capability expires after the maximum seven-day lifetime.
  const bucketName = env.NOELLE_MEDIA_BUCKET!;
  const signingCredentials = createGoogleCredentialClient({ authOptions: { scopes: GCS_AUTH_SCOPES } });
  credentialClient = signingCredentials;
  const signer = createGcsSigner({ credentials: signingCredentials });
  const SIGNED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  cached = createGcsMediaStorage({
    bucket: bucketName,
    endpoint: signer.endpoint,
    timeoutMs: signer.timeoutMs,
    getAccessToken: timeout => signingCredentials.getAccessToken(timeout),
    async resolveUrl(fullPath) {
      const [url] = await signer.getSignedUrl(bucketName, fullPath, {
        version: "v4",
        action: "read",
        expires: Date.now() + SIGNED_TTL_MS,
      });
      return url;
    },
  });
  return cached;
}

export async function resetContentStorageForTests(): Promise<void> {
  const closing = credentialClient;
  credentialClient = undefined;
  cached = undefined;
  await closing?.close();
}

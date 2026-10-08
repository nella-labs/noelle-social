import { defaultGoogleCredentialClient } from "./googleCredentials.js";
import { createGcsSigner } from "./gcsSigner.js";
import { createGcsObjectClient } from "./gcsObjects.js";
import { createGcsStorageReader } from "./gcsStorageReader.js";
import type { StorageDeps } from "./vaultStorage.js";
import { VAULT_TEXT_MAX_BYTES } from "./vaultText.js";

/** SDK-shaped vault dependencies retain only canonical V4 signing in the SDK. */
export function createGcsVaultStorage(options: { timeoutMs?: number } = {}): StorageDeps {
  const credentials = defaultGoogleCredentialClient();
  const signer = createGcsSigner({ credentials, ...options });
  const transport = { endpoint: signer.endpoint, timeoutMs: signer.timeoutMs,
    getAccessToken: (timeout: number) => credentials.getAccessToken(timeout) };
  const reader = createGcsStorageReader(transport), objects = createGcsObjectClient(transport);
  return { bucket(bucket) {
    return {
      getFiles: args => reader.bucket(bucket).getFiles(args ?? {}),
      file(name) { return {
        getSignedUrl: args => signer.getSignedUrl(bucket, name, args),
        delete: () => objects.remove({ bucket, name }),
        save: (body, args) => objects.write({ bucket, name, ...(typeof body === "string" ? { text: body } : { bytes: body }),
          contentType: typeof args?.contentType === "string" ? args.contentType : "text/markdown" }),
        download: async (): Promise<[Buffer]> => [await objects.read({ bucket, name, maxBytes: VAULT_TEXT_MAX_BYTES })],
      }; },
    };
  } };
}

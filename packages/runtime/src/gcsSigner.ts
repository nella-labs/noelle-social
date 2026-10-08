import { AsyncLocalStorage } from "node:async_hooks";
import { Storage, type GetSignedUrlConfig } from "@google-cloud/storage";
import { cliTimeoutMs } from "./cliProcess.js";
import { defaultGoogleCredentialClient, type GoogleCredentialClient, type GoogleCredentialMetadata } from "./googleCredentials.js";

/** SDK V4 signing uses the canonical credential owner and one per-call deadline. */
export function createGcsSigner(options: {
  credentials?: Omit<GoogleCredentialClient, "close">;
  timeoutMs?: number;
} = {}) {
  const configuredTimeout = cliTimeoutMs(options.timeoutMs ?? 20_000);
  const credentials = options.credentials ?? defaultGoogleCredentialClient();
  const sdk = new Storage({ timeout: configuredTimeout, retryOptions: { autoRetry: false } });
  const timeout = Math.min(configuredTimeout, cliTimeoutMs(sdk.timeout ?? configuredTimeout));
  const deadlines = new AsyncLocalStorage<number>();
  const remaining = () => {
    const value = Math.floor((deadlines.getStore() ?? performance.now() + timeout) - performance.now());
    if (value < 1) throw new Error("GCS signing timeout");
    return Math.min(8000, value);
  };
  type Callback = (error: Error | null, metadata?: GoogleCredentialMetadata) => void;
  function getCredentials(): Promise<GoogleCredentialMetadata>;
  function getCredentials(callback: Callback): void;
  function getCredentials(callback?: Callback): Promise<GoogleCredentialMetadata> | void {
    const pending = credentials.getCredentials(remaining());
    if (callback) { void pending.then(value => callback(null, value), error => callback(error)); return; }
    return pending;
  }
  sdk.authClient.getCredentials = getCredentials;
  sdk.authClient.sign = (data, endpoint) => credentials.sign(data, endpoint, remaining());
  return {
    endpoint: sdk.apiEndpoint,
    timeoutMs: timeout,
    getSignedUrl(bucket: string, name: string, args: GetSignedUrlConfig): Promise<[string]> {
      return deadlines.run(performance.now() + timeout, () => sdk.bucket(bucket).file(name).getSignedUrl(args));
    },
  };
}

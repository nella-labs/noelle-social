import { GoogleCredentialsOwner, GoogleCredentialError, type GoogleCredentialOptions } from "./googleCredentialsOwner.js";
export { GoogleCredentialError, type GoogleCredentialOptions } from "./googleCredentialsOwner.js";
export type GoogleCredentialMetadata = { client_email?: string; universe_domain?: string };
export type GoogleCredentialClient = {
  getAccessToken(timeoutMs?: number): Promise<string>;
  getCredentials(timeoutMs?: number): Promise<GoogleCredentialMetadata>;
  sign(data: string, endpoint?: string, timeoutMs?: number): Promise<string>;
  close(): Promise<void>;
};

/** Deadlines include queueing, ADC discovery, token refresh and SDK signing; operations never retry here. */
export function createGoogleCredentialClient(options: GoogleCredentialOptions = {}): GoogleCredentialClient {
  const owner = new GoogleCredentialsOwner(options);
  return {
    getAccessToken: timeout => owner.request("token", [], timeout) as Promise<string>,
    getCredentials: timeout => owner.request("metadata", [], timeout) as Promise<GoogleCredentialMetadata>,
    sign(data, endpoint, timeout) {
      if (typeof data !== "string" || Buffer.byteLength(data) > 65536 || (endpoint !== undefined &&
        (typeof endpoint !== "string" || endpoint.length > 2048))) return Promise.reject(new GoogleCredentialError("invalid_request", "sign"));
      return owner.request("sign", [data, endpoint], timeout) as Promise<string>;
    },
    close: () => owner.close(),
  };
}

let defaultClient: GoogleCredentialClient | undefined;
/** Shared cloud-platform ADC owner prevents a new credential process for each drafting tick. */
export function defaultGoogleCredentialClient(): Omit<GoogleCredentialClient, "close"> {
  return defaultClient ??= createGoogleCredentialClient();
}

import type { GoogleAuthOptions } from "google-auth-library";

export class SecretProtocolError extends Error {
  constructor(readonly code: "invalid_request" | "invalid_response" | "body_too_large") {
    super(code);
  }
}
export const MAX_SECRET_BYTES = 64 * 1024;
export const MAX_SECRET_REQUEST_BYTES = 128 * 1024;
export const MAX_SECRET_RECEIPT_BYTES = 128 * 1024;
export type SecretOperation = "access" | "get" | "list" | "create" | "add" | "disable";
export type SecretSdkOptions = {
  projectId?: string;
  fallback?: boolean;
  protocol?: "http" | "https";
  apiEndpoint?: string;
  port?: number;
};
export type SecretWifAuth = {
  audience: string;
  subjectToken: string;
  serviceAccountImpersonationUrl: string;
  tokenUrl?: string;
};
export type SecretProcessConfig = {
  authOptions?: GoogleAuthOptions | undefined;
  wif?: SecretWifAuth | undefined;
  sdkOptions?: SecretSdkOptions | undefined;
};
export type SecretOperationRequest = {
  operation: SecretOperation;
  name: string;
  pageSize?: number;
  pageToken?: string | undefined;
  filter?: string | undefined;
  secretId?: string;
  labels?: Record<string, string> | undefined;
  payloadBase64?: string;
};
export type SecretVersion = {
  name: string;
  state?: "ENABLED" | "DISABLED" | "DESTROYED";
  createTime?: { seconds: string; nanos: number };
};
export type SecretReceipt = {
  ok: boolean;
  code?: string | number;
  data?: string;
  value?: SecretVersion;
  versions?: SecretVersion[];
  nextPageToken?: string;
};
export function decodeSecretPayload(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new SecretProtocolError("invalid_response");
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > MAX_SECRET_BYTES) throw new SecretProtocolError("body_too_large");
  return bytes;
}
export function validateSecretRequest(request: SecretOperationRequest): void {
  if (
    !request ||
    !["access", "get", "list", "create", "add", "disable"].includes(request.operation) ||
    typeof request.name !== "string" ||
    request.name.length < 1 ||
    request.name.length > 1024
  )
    throw new SecretProtocolError("invalid_request");
  if (
    request.operation === "list" &&
    (!Number.isInteger(request.pageSize) || request.pageSize! < 1 || request.pageSize! > 100)
  )
    throw new SecretProtocolError("invalid_request");
  if (
    request.pageToken != null &&
    (typeof request.pageToken !== "string" || request.pageToken.length > 4096)
  )
    throw new SecretProtocolError("invalid_request");
  if (request.operation === "add") decodeSecretPayload(request.payloadBase64);
}
export function validateSecretReceipt(
  request: SecretOperationRequest,
  receipt: SecretReceipt,
): void {
  if (request.operation === "access") {
    decodeSecretPayload(receipt.data);
    return;
  }
  const valid = (version: SecretVersion | undefined, exact?: string) => {
    if (
      !version ||
      typeof version.name !== "string" ||
      version.name.length > 1024 ||
      (exact ? version.name !== exact : !version.name.startsWith(`${request.name}/versions/`))
    )
      throw new SecretProtocolError("invalid_response");
    if (["list", "add", "disable"].includes(request.operation)) {
      const suffix = version.name.slice(
        exact ? version.name.lastIndexOf("/versions/") + 10 : request.name.length + 10,
      );
      if (
        !/^[1-9][0-9]*$/.test(suffix) ||
        !["ENABLED", "DISABLED", "DESTROYED"].includes(version.state ?? "") ||
        (request.operation === "add" && version.state !== "ENABLED") ||
        (request.operation === "disable" && version.state !== "DISABLED")
      )
        throw new SecretProtocolError("invalid_response");
    }
  };
  if (request.operation === "list") {
    if (
      !Array.isArray(receipt.versions) ||
      receipt.versions.length > request.pageSize! ||
      (receipt.nextPageToken != null &&
        (typeof receipt.nextPageToken !== "string" || receipt.nextPageToken.length > 4096))
    )
      throw new SecretProtocolError("invalid_response");
    for (const version of receipt.versions) valid(version);
  } else if (request.operation === "add") valid(receipt.value);
  else
    valid(
      receipt.value,
      request.operation === "create" ? `${request.name}/secrets/${request.secretId}` : request.name,
    );
}

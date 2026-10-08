import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { ExternalAccountClient, GoogleAuth, type AuthClient } from "google-auth-library";
import {
  MAX_SECRET_BYTES,
  MAX_SECRET_REQUEST_BYTES,
  MAX_SECRET_RECEIPT_BYTES,
  validateSecretRequest,
  decodeSecretPayload,
  SecretProtocolError,
  type SecretOperationRequest,
  type SecretProcessConfig,
  type SecretReceipt,
  type SecretVersion,
} from "./secretProtocol.js";

let sdk: SecretManagerServiceClient | undefined;
let receipt: SecretReceipt;
let operationStarted = false;
let mutation = false;
function version(value: {
  name?: string | null;
  state?: string | number | null;
  createTime?: { seconds?: unknown; nanos?: number | null } | null;
}): SecretVersion {
  const seconds = value.createTime?.seconds;
  const states = { 1: "ENABLED", 2: "DISABLED", 3: "DESTROYED" } as const;
  const state =
    typeof value.state === "number" ? states[value.state as keyof typeof states] : value.state;
  return {
    name: value.name ?? "",
    ...(["ENABLED", "DISABLED", "DESTROYED"].includes(state ?? "")
      ? { state: state as NonNullable<SecretVersion["state"]> }
      : {}),
    ...(seconds != null
      ? {
          createTime: {
            seconds: String(seconds),
            nanos: value.createTime?.nanos ?? 0,
          },
        }
      : {}),
  };
}
try {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > MAX_SECRET_REQUEST_BYTES) throw new Error("request_too_large");
    chunks.push(bytes);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SecretOperationRequest &
    SecretProcessConfig;
  validateSecretRequest(request);
  mutation = ["create", "add", "disable"].includes(request.operation);
  const timeout = Number(process.argv[2]);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000)
    throw new Error("invalid_request");
  let auth = request.authOptions ? new GoogleAuth(request.authOptions) : undefined;
  if (request.wif) {
    const wif = request.wif;
    const authClient = ExternalAccountClient.fromJSON({
      type: "external_account",
      audience: wif.audience,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: wif.tokenUrl ?? "https://sts.googleapis.com/v1/token",
      service_account_impersonation_url: wif.serviceAccountImpersonationUrl,
      subject_token_supplier: { getSubjectToken: async () => wif.subjectToken },
    });
    if (!authClient) throw new Error("invalid_auth");
    auth = new GoogleAuth<AuthClient>({
      authClient,
      ...(request.sdkOptions?.projectId ? { projectId: request.sdkOptions.projectId } : {}),
    });
  }
  sdk = new SecretManagerServiceClient({
    ...request.sdkOptions,
    "grpc.max_receive_message_length": MAX_SECRET_RECEIPT_BYTES,
    "grpc.max_send_message_length": MAX_SECRET_REQUEST_BYTES,
    ...(auth ? { auth } : {}),
  });
  await sdk.initialize();
  await sdk.auth.getRequestHeaders(
    `https://${request.sdkOptions?.apiEndpoint ?? "secretmanager.googleapis.com"}/`,
  );
  operationStarted = true;
  const options = { timeout, retry: null };
  switch (request.operation) {
    case "access": {
      const [response] = await sdk.accessSecretVersion({ name: request.name }, options);
      const payload = response.payload?.data;
      if (payload == null) throw new Error("empty_payload");
      const bytes =
        typeof payload === "string" ? decodeSecretPayload(payload) : Buffer.from(payload);
      if (bytes.byteLength > MAX_SECRET_BYTES) throw new SecretProtocolError("body_too_large");
      receipt = { ok: true, data: bytes.toString("base64") };
      break;
    }
    case "get": {
      const [response] = await sdk.getSecret({ name: request.name }, options);
      receipt = { ok: true, value: version(response) };
      break;
    }
    case "list": {
      const [versions, , response] = await sdk.listSecretVersions(
        {
          parent: request.name,
          pageSize: request.pageSize!,
          pageToken: request.pageToken ?? "",
          filter: request.filter ?? "",
        },
        { ...options, autoPaginate: false },
      );
      receipt = {
        ok: true,
        versions: versions.map(version),
        nextPageToken: response?.nextPageToken ?? "",
      };
      break;
    }
    case "create": {
      const [response] = await sdk.createSecret(
        {
          parent: request.name,
          secretId: request.secretId!,
          secret: { replication: { automatic: {} }, labels: request.labels ?? {} },
        },
        options,
      );
      receipt = { ok: true, value: version(response) };
      break;
    }
    case "add": {
      const [response] = await sdk.addSecretVersion(
        { parent: request.name, payload: { data: decodeSecretPayload(request.payloadBase64) } },
        options,
      );
      receipt = { ok: true, value: version(response) };
      break;
    }
    case "disable": {
      const [response] = await sdk.disableSecretVersion({ name: request.name }, options);
      receipt = { ok: true, value: version(response) };
      break;
    }
  }
  if (Buffer.byteLength(JSON.stringify(receipt)) > MAX_SECRET_RECEIPT_BYTES)
    throw new SecretProtocolError("body_too_large");
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  receipt = {
    ok: false,
    code:
      error instanceof SecretProtocolError
        ? error.code
        : !operationStarted
          ? "failed"
          : code === 5 || code === 404
            ? 5
            : code === 6 || code === 409
              ? 6
              : code === 7 || code === 403
                ? 7
                : mutation
                  ? "outcome_unknown"
                  : "failed",
  };
} finally {
  try {
    await sdk?.close();
  } catch {
    receipt = { ok: false, code: mutation ? "outcome_unknown" : "failed" };
  }
}
process.stdout.write(JSON.stringify(receipt!), () => process.exit(0));

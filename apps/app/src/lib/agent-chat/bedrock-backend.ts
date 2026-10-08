import { BedrockProcess, createBedrockBackend, type EngineBackend } from "@noelle/runtime";
import { getSecretManagerClient, SM_PROJECT } from "@/lib/sm";

// Dashboard calls resolve credentials for each invocation and share only the
// canonical native process admission owner.

const ACCESS_KEY_SECRET = "noelle-worker-bedrock-aws-access-key-id";
const SECRET_KEY_SECRET = "noelle-worker-bedrock-aws-secret-access-key";
const BEDROCK_REGION = "us-east-1";

declare global {
  var __noelleAppBedrockProcess: BedrockProcess | undefined;
}

/**
 * Errors thrown here are translated by callers into a 503 / failure result. The
 * tagged `stage` lets the server log split "couldn't auth to Secret Manager"
 * from "Secret Manager returned an empty payload" — different fixes (WIF IAM vs.
 * populating the secret).
 */
export class BedrockInitError extends Error {
  constructor(
    message: string,
    readonly stage:
      | "secret_manager_client"
      | "secret_manager_fetch"
      | "secret_empty"
      | "backend_construct",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BedrockInitError";
  }
}

function readPayload(data: unknown): string | null {
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf-8").trim();
  if (typeof data === "string") return data.trim();
  return null;
}

/**
 * Resolve the Bedrock AWS creds. Self-host (`NOELLE_SECRETS_SOURCE=env`) reads
 * them straight from the process env — the same place the worker pool gets them
 * — so the dashboard does NOT depend on GCP Secret Manager (whose ADC token
 * expires on the self-host VM). Managed keeps the WIF/ADC Secret Manager path.
 */
async function loadBedrockCreds(): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  if (process.env.NOELLE_SECRETS_SOURCE === "env") {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
    };
  }

  let sm: Awaited<ReturnType<typeof getSecretManagerClient>>;
  try {
    sm = await getSecretManagerClient();
  } catch (err) {
    throw new BedrockInitError(
      "Could not initialise GCP Secret Manager client (WIF / ADC).",
      "secret_manager_client",
      err,
    );
  }

  let accessRes, secretRes;
  try {
    const [access, secret] = await Promise.allSettled([
      sm.accessSecretVersion({ name: `projects/${SM_PROJECT}/secrets/${ACCESS_KEY_SECRET}/versions/latest` }),
      sm.accessSecretVersion({ name: `projects/${SM_PROJECT}/secrets/${SECRET_KEY_SECRET}/versions/latest` }),
    ]);
    if (access.status === "rejected") throw access.reason;
    if (secret.status === "rejected") throw secret.reason;
    accessRes = access.value;
    secretRes = secret.value;
  } catch (err) {
    throw new BedrockInitError(
      `Secret Manager refused to return Bedrock credentials (project=${SM_PROJECT}, secrets=${ACCESS_KEY_SECRET},${SECRET_KEY_SECRET}).`,
      "secret_manager_fetch",
      err,
    );
  }

  return {
    accessKeyId: readPayload(accessRes[0]?.payload?.data) ?? "",
    secretAccessKey: readPayload(secretRes[0]?.payload?.data) ?? "",
  };
}

/** Construct an invocation-scoped backend using current worker credentials. */
export async function loadBedrockBackend(maxTokens = 512): Promise<EngineBackend> {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new RangeError("Bedrock maxTokens must be a positive safe integer");
  }
  delete (globalThis as unknown as { __noelleBedrockBackends?: unknown }).__noelleBedrockBackends;

  const { accessKeyId, secretAccessKey } = await loadBedrockCreds();
  const missing: string[] = [];
  if (!accessKeyId) missing.push(ACCESS_KEY_SECRET);
  if (!secretAccessKey) missing.push(SECRET_KEY_SECRET);
  if (missing.length > 0) {
    throw new BedrockInitError(`No Bedrock credentials available for: ${missing.join(", ")}.`, "secret_empty");
  }

  try {
    const processOwner = (globalThis.__noelleAppBedrockProcess ??= new BedrockProcess());
    return createBedrockBackend({ region: BEDROCK_REGION, accessKeyId, secretAccessKey, maxTokens, processOwner });
  } catch (err) {
    throw new BedrockInitError("createBedrockBackend() threw — credentials may be malformed.", "backend_construct", err);
  }
}

export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof BedrockInitError) {
    return { name: err.name, stage: err.stage, message: err.message, cause: err.cause ? serializeError(err.cause) : undefined };
  }
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack?.split("\n").slice(0, 5).join("\n"),
      cause: err.cause ? serializeError(err.cause) : undefined,
    };
  }
  return { value: String(err) };
}

import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  BoundedProcessQueue,
  CliProcessError,
  ProcessAdmissionError,
  runCliProcess,
} from "@noelle/process";
import {
  SecretProtocolError,
  MAX_SECRET_BYTES,
  MAX_SECRET_REQUEST_BYTES,
  MAX_SECRET_RECEIPT_BYTES,
  validateSecretRequest,
  validateSecretReceipt,
  type SecretOperationRequest,
  type SecretProcessConfig,
  type SecretReceipt,
} from "./secretProtocol.js";

type Code =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "PERMISSION_DENIED"
  | "failed"
  | "timeout"
  | "busy"
  | "cleanup_failed"
  | "unsupported_platform"
  | "request_too_large"
  | "body_too_large"
  | "empty_payload"
  | "invalid_response"
  | "outcome_unknown";
export class SecretAccessError extends Error {
  constructor(
    message: string,
    readonly code: Code = "failed",
  ) {
    super(message);
    this.name = "SecretAccessError";
  }
}
export function secretTimeoutMs(value = 8000): number {
  if (!Number.isInteger(value) || value < 1 || value > 30_000)
    throw new SecretAccessError("Invalid secret timeout");
  return value;
}
export function safeSecretCode(error: unknown): Code {
  if (error instanceof SecretProtocolError)
    return error.code === "body_too_large" ? error.code : "invalid_response";
  if (error instanceof SecretAccessError || error instanceof ProcessAdmissionError)
    return error.code;
  if (error instanceof CliProcessError)
    return error.code === "timed_out"
      ? "timeout"
      : error.code === "cleanup_failed"
        ? error.code
        : "failed";
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return code === 5
    ? "NOT_FOUND"
    : code === 6
      ? "ALREADY_EXISTS"
      : code === 7
        ? "PERMISSION_DENIED"
        : "failed";
}
function receiptCode(code: unknown): Code {
  if (code === 5) return "NOT_FOUND";
  if (code === 6) return "ALREADY_EXISTS";
  if (code === 7) return "PERMISSION_DENIED";
  return code === "body_too_large" || code === "outcome_unknown" ? code : "failed";
}
/** One resource owner admits reads and writes; a returned value requires child closure. */
export class SecretManagerProcess {
  private admission = new BoundedProcessQueue();
  checkAvailable(): void {
    try {
      this.admission.checkAvailable();
    } catch (error) {
      throw new SecretAccessError("Secret admission unavailable", safeSecretCode(error));
    }
  }
  async request(
    request: SecretOperationRequest,
    config: SecretProcessConfig,
    deadline: number,
  ): Promise<SecretReceipt> {
    const mutation = ["create", "add", "disable"].includes(request.operation);
    let started = false;
    try {
      this.checkAvailable();
      validateSecretRequest(request);
      if (process.platform === "win32")
        throw new SecretAccessError("Unsupported platform", "unsupported_platform");
      const input = JSON.stringify({ ...request, ...config }, (_key, value) => {
        if (typeof value === "function" || typeof value === "bigint")
          throw new SecretAccessError("Invalid secret request");
        return value;
      });
      if (
        Buffer.byteLength(input) >
        (request.operation === "access" ? MAX_SECRET_BYTES : MAX_SECRET_REQUEST_BYTES)
      )
        throw new SecretAccessError("Secret request too large", "request_too_large");
      return await this.admission.run(deadline, async (timeoutMs) => {
        started = true;
        const result = await runCliProcess({
          command: process.execPath,
          argv: [
            "--max-old-space-size=64",
            fileURLToPath(new URL("./secretWorker.js", import.meta.url)),
            String(timeoutMs),
          ],
          prompt: input,
          timeoutMs,
          env: process.env,
          cwd: tmpdir(),
        });
        if (result.code !== 0 || Buffer.byteLength(result.stdout) > MAX_SECRET_RECEIPT_BYTES)
          throw new SecretAccessError("Invalid secret response", "invalid_response");
        const receipt = JSON.parse(result.stdout) as SecretReceipt;
        if (!receipt || receipt.ok !== true)
          throw new SecretAccessError("Secret operation failed", receiptCode(receipt?.code));
        validateSecretReceipt(request, receipt);
        return receipt;
      });
    } catch (error) {
      let code = safeSecretCode(error);
      if (
        mutation &&
        started &&
        !["NOT_FOUND", "ALREADY_EXISTS", "PERMISSION_DENIED"].includes(code)
      )
        code = "outcome_unknown";
      throw new SecretAccessError(
        code === "outcome_unknown"
          ? "Secret mutation outcome unknown; check its status before retrying."
          : `Secret operation ${code}`,
        code,
      );
    }
  }
}

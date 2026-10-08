import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type {
  Message,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages";
import { CliProcessError, runCliProcess } from "./cliProcess.js";
import { BoundedProcessQueue, ProcessAdmissionError } from "@noelle/process";

export const MAX_BEDROCK_REQUEST_BYTES = 4 * 1024 * 1024;

export class BedrockProcessError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly cacheControl = false,
  ) {
    super(cacheControl ? "Bedrock cache control rejected" : `Bedrock request ${code}`);
    this.name = "BedrockProcessError";
  }
}
type Request = {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  body: MessageCreateParamsNonStreaming;
};
/** At most four SDK processes and 32 admitted requests; waiting time consumes the same deadline. */
export class BedrockProcess {
  private admission = new BoundedProcessQueue();
  request(request: Request, deadline: number): Promise<Message> {
    if (process.platform === "win32")
      return Promise.reject(new BedrockProcessError("unsupported_platform"));
    try {
      this.admission.checkAvailable();
    } catch (error) {
      return Promise.reject(new BedrockProcessError((error as ProcessAdmissionError).code));
    }
    let remaining = Math.floor(deadline - performance.now());
    if (!Number.isFinite(remaining) || remaining < 1)
      return Promise.reject(new BedrockProcessError("timeout"));
    let input: string;
    try {
      input = JSON.stringify(request);
    } catch {
      return Promise.reject(new BedrockProcessError("invalid_request"));
    }
    if (Buffer.byteLength(input) > MAX_BEDROCK_REQUEST_BYTES)
      return Promise.reject(new BedrockProcessError("request_too_large"));
    remaining = Math.floor(deadline - performance.now());
    if (!Number.isFinite(remaining) || remaining < 1)
      return Promise.reject(new BedrockProcessError("timeout"));
    return this.admission
      .run(deadline, (timeoutMs) => this.execute(input, deadline, timeoutMs))
      .catch((error) => {
        throw error instanceof BedrockProcessError
          ? error
          : new BedrockProcessError(
              error instanceof ProcessAdmissionError
                ? error.code
                : error instanceof CliProcessError
                  ? error.code === "timed_out"
                    ? "timeout"
                    : error.code
                  : "failed",
            );
      });
  }
  private async execute(input: string, deadline: number, timeoutMs: number): Promise<Message> {
    const result = await runCliProcess({
      command: process.execPath,
      argv: [
        "--max-old-space-size=64",
        fileURLToPath(new URL("./bedrockWorker.js", import.meta.url)),
        String(timeoutMs),
      ],
      prompt: input,
      timeoutMs,
      env: process.env,
      cwd: tmpdir(),
    });
    if (performance.now() >= deadline) throw new BedrockProcessError("timeout");
    if (result.code !== 0) throw new BedrockProcessError("failed");
    let receipt: {
      ok?: boolean;
      value?: Message;
      code?: string;
      status?: number;
      cacheControl?: boolean;
    };
    try {
      receipt = JSON.parse(result.stdout);
    } catch {
      throw new BedrockProcessError("invalid_response");
    }
    if (!receipt || typeof receipt !== "object") throw new BedrockProcessError("invalid_response");
    if (receipt.ok !== true) {
      const status =
        Number.isInteger(receipt.status) && receipt.status! >= 100 && receipt.status! <= 599
          ? receipt.status
          : undefined;
      const code = ["timeout", "body_too_large", "aborted", "invalid_json", "network"].includes(
        receipt.code ?? "",
      )
        ? receipt.code!
        : "failed";
      throw new BedrockProcessError(code, status, receipt.cacheControl === true);
    }
    if (
      !receipt.value ||
      !Array.isArray(receipt.value.content) ||
      !receipt.value.usage ||
      typeof receipt.value.usage !== "object"
    ) {
      throw new BedrockProcessError("invalid_response");
    }
    if (performance.now() >= deadline) throw new BedrockProcessError("timeout");
    return receipt.value;
  }
}

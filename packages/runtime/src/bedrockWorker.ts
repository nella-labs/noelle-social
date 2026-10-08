import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { createBoundedHttpFetch, HttpBodyError, MAX_HTTP_TIMEOUT_MS } from "./boundedHttp.js";
import { isCacheControlError } from "./promptCache.js";

/** Fixed SDK entry point; prompts and credentials arrive only through the owned stdin pipe. */
async function run(): Promise<unknown> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const timeoutMs = Number(process.argv[2]);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_HTTP_TIMEOUT_MS) throw new Error("invalid_request");
    const client = new AnthropicBedrock({ awsRegion: request.region, maxRetries: 0, logLevel: "off", timeout: timeoutMs,
      ...(request.accessKeyId && request.secretAccessKey ? {
        awsAccessKey: request.accessKeyId, awsSecretKey: request.secretAccessKey,
      } : {}), fetch: createBoundedHttpFetch({ timeoutMs }) });
    return { ok: true, value: await client.messages.create(request.body) };
  } catch (error) {
    const sdkError = error as { status?: number; cause?: unknown };
    let cause: unknown = error;
    for (let depth = 0; depth < 5 && !(cause instanceof HttpBodyError); depth++) {
      if (!cause || typeof cause !== "object" || !("cause" in cause)) break;
      cause = cause.cause;
    }
    return { ok: false, status: sdkError?.status,
      code: cause instanceof HttpBodyError ? cause.code : "failed", cacheControl: isCacheControlError(error) };
  }
}
void run().then(receipt => {
  process.stdout.write(JSON.stringify(receipt), () => process.exit(0));
});

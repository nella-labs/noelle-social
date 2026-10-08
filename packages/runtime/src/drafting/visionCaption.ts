// Describe a bounded set of images for the drafting brief. Each image and
// generation HTTP request owns its complete body deadline and byte bound.
// Default Google credential discovery has a separate owned deadline.
import { createBoundedHttpFetch, decodeHttpJson, fetchBoundedHttpResponse } from "../boundedHttp.js";
import { parseGeminiGeneration } from "../geminiResponse.js";
import { reportedAnthropicUsage } from "../promptCache.js";
import { isBudgetAdmissionError } from "../budgetAdmissionErrors.js";
import { runCaptionModel, type CaptionMetering } from "./captionMetering.js";
import { defaultGoogleCredentialClient } from "../googleCredentials.js";
import { readImageMimeType } from "../imageMime.js";
export type { CaptionMetering } from "./captionMetering.js";

export type CaptionFn = (
  imageUrls: string[],
  ctx: { postText?: string },
) => Promise<string>;

export interface CaptionImagesArgs {
  imageUrls: string[];
  postText?: string;
  /** The concrete vision call. When absent, captionImages returns "" (no-op). */
  captionFn?: CaptionFn;
  /** Cap how many images we send to the vision model (default 3). */
  maxImages?: number;
}

/**
 * Describe a post's images in words. Returns "" when there are no images, no
 * captionFn is wired, or an ordinary vision call fails. Admission failures
 * propagate so drafting cannot continue after a denied paid call.
 */
export async function captionImages(args: CaptionImagesArgs): Promise<string> {
  const urls = (args.imageUrls ?? []).filter(
    (u) => typeof u === "string" && /^https?:\/\//i.test(u),
  );
  if (urls.length === 0 || !args.captionFn) return "";
  const requested = args.maxImages ?? 3;
  const count = Number.isFinite(requested) ? Math.max(0, Math.min(3, Math.floor(requested))) : 0;
  const capped = urls.slice(0, count);
  if (!capped.length) return "";
  const ctx: { postText?: string } = {};
  if (args.postText !== undefined) ctx.postText = args.postText;
  try {
    const caption = await args.captionFn(capped, ctx);
    return typeof caption === "string" ? caption.trim() : "";
  } catch (error) {
    if (isBudgetAdmissionError(error)) throw error;
    return "";
  }
}

const VISION_INSTRUCTION =
  "Look closely at this social-media post's image — a reply will be written that may need to engage with it, so describe it concretely. In 2-4 short sentences cover: (1) what kind of image it is (chart, screenshot, meme, product shot, selfie, diagram, photo); (2) any text, numbers, labels, or data visible in it, transcribed as exactly as you can; (3) the single point or mood it's making. Be factual and specific — name what's actually there, don't generalize. No preamble, just the description.";

function toBase64(buf: Uint8Array): string {
  // Node + modern runtimes: Buffer is available in the worker processes.
  return Buffer.from(buf).toString("base64");
}

/** Download at most three images, each bounded to 5 MiB and its full HTTP deadline. */
async function fetchImageBytes(
  imageUrls: string[],
  fetchImpl: typeof fetch,
  timeoutMs: number,
  allowGif = false,
): Promise<Array<{ mime: string; data: string }>> {
  const out: Array<{ mime: string; data: string }> = [];
  for (const url of imageUrls.slice(0, 3)) {
    const { response: img, bytes } = await fetchBoundedHttpResponse(url, {}, { fetchImpl, timeoutMs, maxBytes: 5 * 1024 * 1024 });
    if (!img.ok) continue;
    const mime = readImageMimeType(bytes);
    if (!mime || (mime === "image/gif" && !allowGif)) continue;
    out.push({ mime, data: toBase64(bytes) });
  }
  return out;
}

/** Gemini-key caption generation. captionImages converts request or decoding failures to empty context. */
export function createGeminiCaptionFn(opts: {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  metering?: CaptionMetering;
}): CaptionFn {
  const model = opts.model ?? "gemini-2.5-flash";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  return async (imageUrls, ctx) => {
    if (!opts.apiKey || imageUrls.length === 0) return "";
    // Fetch image bytes → inline base64 parts. Skip any that fail to download.
    const bytes = await fetchImageBytes(imageUrls, fetchImpl, timeoutMs);
    const imageParts = bytes.map((b) => ({
      inline_data: { mime_type: b.mime, data: b.data },
    }));
    if (imageParts.length === 0) return "";
    const promptText = ctx.postText
      ? `${VISION_INSTRUCTION}\n\nThe post's text (for context): ${ctx.postText.slice(0, 500)}`
      : VISION_INSTRUCTION;
    return runCaptionModel({
      engine: "vertex", model: opts.model === undefined ? "gemini-2-5-flash" : model,
      prompt: promptText, images: bytes, timeoutMs, ...(opts.metering ? { metering: opts.metering } : {}),
      call: async () => {
        const received = await fetchBoundedHttpResponse(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${opts.apiKey}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: promptText }, ...imageParts] }],
            }),
          }, { fetchImpl, timeoutMs },
        );
        if (!received.response.ok) throw new Error(`Gemini vision request rejected: HTTP ${received.response.status}`);
        return parseGeminiGeneration(decodeHttpJson(received.bytes), " ");
      },
    });
  };
}

/** Minimal auth client shape (matches google-auth-library's GoogleAuth). */
export type VisionAuthClient = { getAccessToken(): Promise<string | null | undefined> };

/** Vertex caption generation with separate owned ADC and complete HTTP deadlines. Injected auth is caller-owned. */
export function createVertexCaptionFn(opts: {
  project: string;
  location?: string;
  model?: string;
  authClient?: VisionAuthClient;
  /** Default ADC operation deadline. Default 8 seconds. */
  authTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  metering?: CaptionMetering;
}): CaptionFn {
  const location = opts.location ?? "us-central1";
  const model = opts.model ?? "gemini-2.5-flash";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  return async (imageUrls, ctx) => {
    if (!opts.project || imageUrls.length === 0) return "";
    let token: string | null | undefined;
    try {
      token = opts.authClient ? await opts.authClient.getAccessToken()
        : await defaultGoogleCredentialClient().getAccessToken(opts.authTimeoutMs);
    } catch {
      return "";
    }
    if (typeof token !== "string" || !token.trim()) return "";

    const bytes = await fetchImageBytes(imageUrls, fetchImpl, timeoutMs);
    const imageParts = bytes.map((b) => ({
      inlineData: { mimeType: b.mime, data: b.data },
    }));
    if (imageParts.length === 0) return "";

    const promptText = ctx.postText
      ? `${VISION_INSTRUCTION}\n\nThe post's text (for context): ${ctx.postText.slice(0, 500)}`
      : VISION_INSTRUCTION;
    const url =
      `https://${location}-aiplatform.googleapis.com/v1/projects/${opts.project}` +
      `/locations/${location}/publishers/google/models/${model}:generateContent`;
    return runCaptionModel({
      engine: "vertex", model: opts.model === undefined ? "gemini-2-5-flash" : model,
      prompt: promptText, images: bytes, timeoutMs, ...(opts.metering ? { metering: opts.metering } : {}),
      call: async () => {
        const received = await fetchBoundedHttpResponse(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: promptText }, ...imageParts] }],
          }),
        }, { fetchImpl, timeoutMs });
        if (!received.response.ok) throw new Error(`Vertex vision request rejected: HTTP ${received.response.status}`);
        return parseGeminiGeneration(decodeHttpJson(received.bytes), " ");
      },
    });
  };
}

/** Minimal shape of the Bedrock messages client we use — matches
 * AnthropicBedrock["messages"] for the one `create` call. */
export type BedrockVisionClient = {
  create(args: {
    model: string;
    max_tokens: number;
    messages: Array<{ role: "user"; content: unknown }>;
  }, options?: { signal: AbortSignal; timeout: number; maxRetries: number }): Promise<{ content: Array<{ type: string; text?: string }>; usage?: unknown }>;
};

// @anthropic-ai/bedrock-sdk is loaded lazily so callers that never use Bedrock
// captions (or inject a client) don't force the dependency to resolve.
let cachedBedrock: { new (opts: unknown): { messages: BedrockVisionClient } } | undefined;
async function defaultBedrockClient(opts: {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;

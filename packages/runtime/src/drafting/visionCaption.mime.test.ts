import { describe, expect, it, vi } from "vitest";
import { pngImageBytes, gifImageBytes } from "../imageBytes.fixture.js";
import { createBedrockCaptionFn, createGeminiCaptionFn, createVertexCaptionFn, type BedrockVisionClient } from "./visionCaption.js";

type Provider = "key" | "vertex" | "bedrock";
function setup(kind: Provider, image: Uint8Array<ArrayBuffer>, contentType = "image/jpeg") {
  const parts: Array<{ mime: string; data: string }> = [];
  const paid = vi.fn();
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method !== "POST") return new Response(image, { headers: { "content-type": contentType } });
    paid();
    const body = JSON.parse(String(init.body));
    for (const part of body.contents[0].parts) {
      const value = part.inline_data ?? part.inlineData;
      if (value) parts.push({ mime: value.mime_type ?? value.mimeType, data: value.data });
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "saved caption" }] } }] }));
  });
  const create = vi.fn<BedrockVisionClient["create"]>(async args => {
    paid();
    for (const part of args.messages[0]!.content as Array<{ type: string; source?: { media_type: string; data: string } }>) {
      if (part.type === "image" && part.source) parts.push({ mime: part.source.media_type, data: part.source.data });
    }
    return { content: [{ type: "text", text: "saved caption" }] };
  });
  const caption = kind === "key" ? createGeminiCaptionFn({ apiKey: "inert", fetchImpl })
    : kind === "vertex" ? createVertexCaptionFn({ project: "fixture", fetchImpl, authClient: { getAccessToken: async () => "inert" } })
    : createBedrockCaptionFn({ clientImpl: { create }, fetchImpl });
  return { caption, parts, paid, fetchImpl };
}

describe.each(["key", "vertex", "bedrock"] as const)("%s image byte MIME", kind => {
  it.each(["https://fixture.invalid/frame.jpg", "https://fixture.invalid/image?id=1"])("uses bytes despite URL/header for %s", async url => {
    const bytes = pngImageBytes();
    const s = setup(kind, bytes, "image/jpeg");
    expect(await s.caption([url], {})).toBe("saved caption");
    expect(s.parts).toEqual([{ mime: "image/png", data: Buffer.from(bytes).toString("base64") }]);
  });

  it.each([new TextEncoder().encode("<html>not an image</html>"), new Uint8Array([0x89, 0x50, 0x4e, 0x47])])("skips invalid image bytes %j before paid dispatch", async bytes => {
    const s = setup(kind, bytes, "image/png");
    expect(await s.caption(["https://fixture.invalid/frame.png"], {})).toBe("");
    expect(s.paid).not.toHaveBeenCalled();
  });

  it("keeps each provider's GIF acceptance", async () => {
    const s = setup(kind, gifImageBytes());
    expect(await s.caption(["https://fixture.invalid/frame.jpg"], {})).toBe(kind === "bedrock" ? "saved caption" : "");
    expect(s.parts).toEqual(kind === "bedrock" ? [{ mime: "image/gif", data: Buffer.from(gifImageBytes()).toString("base64") }] : []);
    expect(s.paid).toHaveBeenCalledTimes(kind === "bedrock" ? 1 : 0);
  });
});

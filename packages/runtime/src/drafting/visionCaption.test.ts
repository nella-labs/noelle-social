import { pngImageBytes } from "../imageBytes.fixture.js";
import { describe, expect, it, vi } from "vitest";
import {
  captionImages,
  createGeminiCaptionFn,
  createVertexCaptionFn,
  createBedrockCaptionFn,
} from "./visionCaption.js";

describe("captionImages", () => {
  it("returns '' with no images or no captionFn", async () => {
    expect(await captionImages({ imageUrls: [] })).toBe("");
    expect(await captionImages({ imageUrls: ["https://x/a.jpg"] })).toBe(""); // no captionFn
    const fn = vi.fn().mockResolvedValue("a chart");
    expect(await captionImages({ imageUrls: [], captionFn: fn })).toBe("");
    expect(fn).not.toHaveBeenCalled();
  });

  it("filters non-http urls and caps to maxImages", async () => {
    const fn = vi.fn().mockResolvedValue("desc");
    await captionImages({
      imageUrls: ["data:image/png;base64,xx", "https://x/1.jpg", "https://x/2.jpg", "https://x/3.jpg", "https://x/4.jpg"],
      captionFn: fn,
      maxImages: 2,
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![0]).toEqual(["https://x/1.jpg", "https://x/2.jpg"]);
  });

  it("returns the trimmed caption", async () => {
    const fn = vi.fn().mockResolvedValue("  a flamegraph of a slow build  ");
    expect(await captionImages({ imageUrls: ["https://x/1.jpg"], captionFn: fn })).toBe("a flamegraph of a slow build");
  });

  it("fails open to '' when the captionFn throws", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("vision 500"));
    expect(await captionImages({ imageUrls: ["https://x/1.jpg"], captionFn: fn })).toBe("");
  });
});

describe("createGeminiCaptionFn", () => {
  const imgResponse = () => new Response(pngImageBytes());
  const genResponse = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));

  it("returns '' when apiKey is empty", async () => {
    const fn = createGeminiCaptionFn({ apiKey: "" });
    expect(await fn(["https://x/1.jpg"], {})).toBe("");
  });

  it("fetches the image, calls generateContent, returns the caption text", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(imgResponse()) // image download
      .mockResolvedValueOnce(genResponse("a bar chart of revenue")); // generateContent
    const fn = createGeminiCaptionFn({ apiKey: "k", fetchImpl: fetchImpl as never });
    const out = await fn(["https://x/1.jpg"], { postText: "look at this growth" });
    expect(out).toBe("a bar chart of revenue");
    // First call downloads the image, second hits generateContent with the key.
    expect(fetchImpl.mock.calls[1]![0]).toContain("generateContent?key=k");
  });

  it("returns '' when the image download fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const fn = createGeminiCaptionFn({ apiKey: "k", fetchImpl: fetchImpl as never });
    expect(await fn(["https://x/1.jpg"], {})).toBe("");
  });
});

describe("createVertexCaptionFn", () => {
  const imgResponse = () => new Response(pngImageBytes());
  const genResponse = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
  const auth = { getAccessToken: async () => "tok-123" };

  it("returns '' when project is empty", async () => {
    const fn = createVertexCaptionFn({ project: "", authClient: auth });
    expect(await fn(["https://x/1.jpg"], {})).toBe("");
  });

  it("returns '' when ADC yields no token (fail-open)", async () => {
    const fn = createVertexCaptionFn({ project: "p", authClient: { getAccessToken: async () => null } });
    expect(await fn(["https://x/1.jpg"], {})).toBe("");
  });

  it("hits the Vertex generateContent endpoint with a Bearer token + inlineData", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(imgResponse()) // image download
      .mockResolvedValueOnce(genResponse("a screenshot of a terminal")); // generateContent
    const fn = createVertexCaptionFn({
      project: "noelle-agents",
      location: "us-central1",
      authClient: auth,
      fetchImpl: fetchImpl as never,
    });
    const out = await fn(["https://x/1.jpg"], { postText: "shipped it" });
    expect(out).toBe("a screenshot of a terminal");
    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(url).toContain("us-central1-aiplatform.googleapis.com");
    expect(url).toContain("projects/noelle-agents/locations/us-central1");
    expect(url).toContain(":generateContent");
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe("Bearer tok-123");
    expect((init as { body: string }).body).toContain("inlineData");
  });

  it("fails open to '' when the auth client throws", async () => {
    const fn = createVertexCaptionFn({
      project: "p",
      authClient: { getAccessToken: async () => { throw new Error("ADC down"); } },
    });
    expect(await fn(["https://x/1.jpg"], {})).toBe("");
  });
});

describe("createBedrockCaptionFn", () => {
  const imgResponse = () => new Response(pngImageBytes());

  it("returns '' when there are no images (no client call)", async () => {
    const client = { create: vi.fn() };
    const fn = createBedrockCaptionFn({ clientImpl: client as never });
    expect(await fn([], {})).toBe("");
    expect(client.create).not.toHaveBeenCalled();
  });

  it("sends the image inline to Claude and returns the description text", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(imgResponse()); // image download
    const client = {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "  a flamegraph showing a 3s build  " }],
      }),
    };
    const fn = createBedrockCaptionFn({
      clientImpl: client as never,
      fetchImpl: fetchImpl as never,
    });
    const out = await fn(["https://x/1.jpg"], { postText: "why is my build so slow" });
    expect(out).toBe("a flamegraph showing a 3s build");
    // The image rode along as a base64 image content block.
    const arg = client.create.mock.calls[0]![0];
    const content = arg.messages[0].content as Array<{ type: string }>;
    expect(content.some((c) => c.type === "image")).toBe(true);
    expect(content.some((c) => c.type === "text")).toBe(true);
  });

  it("fails open to '' when the image download fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const client = { create: vi.fn() };
    const fn = createBedrockCaptionFn({ clientImpl: client as never, fetchImpl: fetchImpl as never });
    expect(await fn(["https://x/1.jpg"], {})).toBe("");
    expect(client.create).not.toHaveBeenCalled();
  });

  it("fails open to '' when the Bedrock call throws", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(imgResponse());
    const client = { create: vi.fn().mockRejectedValue(new Error("bedrock 500")) };
    const fn = createBedrockCaptionFn({ clientImpl: client as never, fetchImpl: fetchImpl as never });
    expect(await fn(["https://x/1.jpg"], {})).toBe("");
  });
});

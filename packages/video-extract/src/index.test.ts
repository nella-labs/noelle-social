import { describe, it, expect } from "vitest";
import {
  buildDownloadArgs,
  buildAudioArgs,
  buildKeyframeArgs,
  buildDurationArgs,
  parseSceneCuts,
  parseWhisperJson,
  parseDuration,
  selectKeyframes,
  extractVideo,
  type ExecFn,
} from "./index.js";

describe("arg builders", () => {
  it("download args target the out path + url", () => {
    expect(buildDownloadArgs("https://x/p", "/tmp/v.mp4")).toContain("https://x/p");
    expect(buildDownloadArgs("https://x/p", "/tmp/v.mp4")).toContain("/tmp/v.mp4");
  });
  it("audio args force mono 16k wav", () => {
    const a = buildAudioArgs("/v.mp4", "/a.wav");
    expect(a).toEqual(expect.arrayContaining(["-ac", "1", "-ar", "16000", "-f", "wav"]));
  });
  it("keyframe args carry the scene-select + showinfo filter", () => {
    const a = buildKeyframeArgs("/v.mp4", "/f-%03d.jpg", 0.4);
    expect(a.join(" ")).toContain("select='gt(scene,0.4)',showinfo");
  });
  it("duration args ask ffprobe for format=duration", () => {
    expect(buildDurationArgs("/v.mp4").join(" ")).toContain("format=duration");
  });
});

describe("parseSceneCuts", () => {
  it("pulls ordered pts_time values from showinfo stderr", () => {
    const stderr = "frame:0 pts_time:0.5 ...\nframe:1 pts_time:3.25 ...\nnoise pts_time:7";
    expect(parseSceneCuts(stderr)).toEqual([0.5, 3.25, 7]);
  });
  it("returns [] on empty", () => {
    expect(parseSceneCuts("nothing here")).toEqual([]);
  });
});

describe("parseWhisperJson", () => {
  it("maps segments + text", () => {
    const raw = JSON.stringify({ text: "hello world", segments: [{ start: 0, end: 1.2, text: " hello" }, { start: 1.2, end: 2, text: "world " }] });
    const r = parseWhisperJson(raw);
    expect(r.transcript).toBe("hello world");
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]).toEqual({ start: 0, end: 1.2, text: "hello" });
  });
  it("falls back to raw text when not JSON", () => {
    expect(parseWhisperJson("  just text  ")).toEqual({ transcript: "just text", segments: [] });
  });
});

describe("parseDuration", () => {
  it("parses a bare number, rejects junk", () => {
    expect(parseDuration("28.41\n")).toBe(28.41);
    expect(parseDuration("N/A")).toBeNull();
    expect(parseDuration("0")).toBeNull();
  });
});

describe("selectKeyframes", () => {
  it("returns all when under the cap", () => {
    expect(selectKeyframes(["a", "b"], 6)).toEqual(["a", "b"]);
  });
  it("evenly samples when over the cap", () => {
    const out = selectKeyframes(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"], 3);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("0");
  });
});

describe("extractVideo (fail-open)", () => {
  it("returns EMPTY when download fails (no binaries) without throwing", async () => {
    const exec: ExecFn = async () => {
      throw new Error("ENOENT yt-dlp");
    };
    // videoUrl is non-http so the fetch fallback is skipped too.
    const out = await extractVideo({ videoUrl: "not-a-url", workDir: "/tmp/nova-test-xyz", exec });
    expect(out.transcript).toBe("");
    expect(out.keyframePaths).toEqual([]);
    expect(out.localVideoPath).toBeNull();
  });
});

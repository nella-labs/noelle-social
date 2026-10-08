import { afterEach, describe, expect, it, vi } from "vitest";
import { mediaCopyPath } from "./media-path";

describe("mediaCopyPath", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns empty string for null/undefined/empty", () => {
    expect(mediaCopyPath(null)).toBe("");
    expect(mediaCopyPath(undefined)).toBe("");
    expect(mediaCopyPath("")).toBe("");
  });

  it("passes through already-absolute urls (prod GCS signed link)", () => {
    const signed = "https://storage.googleapis.com/bucket/org/media/abc.png?X-Goog-Signature=deadbeef";
    expect(mediaCopyPath(signed)).toBe(signed);
  });

  it("prefixes the current origin onto a relative uploaded-media path", () => {
    vi.stubGlobal("window", { location: { origin: "https://media.example.test" } });
    expect(mediaCopyPath("/media/operator/media/abc.png")).toBe(
      "https://media.example.test/media/operator/media/abc.png",
    );
  });

  it("prefixes the origin onto an external content-pipeline path", () => {
    vi.stubGlobal("window", { location: { origin: "https://app.trynoelle.com" } });
    expect(mediaCopyPath("/external-media/2026-W12/clip.mp4")).toBe(
      "https://app.trynoelle.com/external-media/2026-W12/clip.mp4",
    );
  });
});

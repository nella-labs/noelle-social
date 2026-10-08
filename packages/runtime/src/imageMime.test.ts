import { describe, expect, it } from "vitest";
import { readImageMimeType } from "./imageMime.js";

describe("image byte MIME signatures", () => {
  it.each([
    [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"],
    [[0xff, 0xd8, 0xff, 0xe0], "image/jpeg"],
    [[0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], "image/webp"],
    [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], "image/gif"],
    [[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], "image/gif"],
  ] as const)("recognizes supported signature %j", (bytes, expected) => {
    expect(readImageMimeType(Uint8Array.from(bytes))).toBe(expected);
  });

  it.each([
    [], [0xff, 0xd8], [0x89, 0x50, 0x4e, 0x47],
    [0x47, 0x49, 0x46, 0x38, 0x39],
    [0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x41, 0x56, 0x45],
    [0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e],
  ].map(bytes => ({ bytes })))("keeps unknown or incomplete signature $bytes unknown", ({ bytes }) => {
    expect(readImageMimeType(Uint8Array.from(bytes))).toBeNull();
  });

  it("reads the supplied view without inspecting its surrounding buffer", () => {
    const container = new Uint8Array([0, 0xff, 0xd8, 0xff, 0, 0]);
    expect(readImageMimeType(container.subarray(1, 4))).toBe("image/jpeg");
    expect(readImageMimeType(container)).toBeNull();
  });
});

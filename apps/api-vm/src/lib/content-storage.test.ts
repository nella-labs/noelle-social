import { describe, it, expect } from "vitest";
import { selectMediaBackend } from "./content-storage.js";

describe("selectMediaBackend", () => {
  it("defaults to local", () => {
    expect(selectMediaBackend({ NOELLE_MEDIA_BACKEND: "local", NOELLE_MEDIA_BUCKET: undefined })).toBe("local");
  });
  it("returns gcs when configured with a bucket", () => {
    expect(selectMediaBackend({ NOELLE_MEDIA_BACKEND: "gcs", NOELLE_MEDIA_BUCKET: "noelle-media" })).toBe("gcs");
  });
  it("throws if gcs is selected without a bucket", () => {
    expect(() => selectMediaBackend({ NOELLE_MEDIA_BACKEND: "gcs", NOELLE_MEDIA_BUCKET: undefined })).toThrow(
      /NOELLE_MEDIA_BUCKET/,
    );
  });
});

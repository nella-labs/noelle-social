import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { md5Base64 } from "./hash.js";

describe("md5Base64", () => {
  it("matches Node's crypto md5 base64 digest (GCS md5Hash format)", () => {
    const body = Buffer.from("# hello\n");
    const expected = createHash("md5").update(body).digest("base64");
    expect(md5Base64(body)).toBe(expected);
  });

  it("is stable for identical content", () => {
    expect(md5Base64(Buffer.from("abc"))).toBe(md5Base64(Buffer.from("abc")));
  });
});

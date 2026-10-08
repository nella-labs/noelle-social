import { describe, expect, it } from "vitest";
import { buildXDmUrl } from "./x-dm-url.js";

describe("buildXDmUrl", () => {
  it("builds a compose link with recipient + prefilled text", () => {
    expect(buildXDmUrl("12345", "hellooo daniel")).toBe(
      "https://x.com/messages/compose?recipient_id=12345&text=hellooo%20daniel",
    );
  });
  it("omits recipient when missing (just opens the composer with text)", () => {
    expect(buildXDmUrl(null, "hi")).toBe(
      "https://x.com/messages/compose?text=hi",
    );
  });
  it("opens a bare composer when nothing is given", () => {
    expect(buildXDmUrl()).toBe("https://x.com/messages/compose");
  });
});

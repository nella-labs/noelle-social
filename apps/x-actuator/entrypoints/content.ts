// Thin wxt entrypoint — all logic lives in src/content/index.ts.
// Static import so the content logic is bundled INTO content.js and runs
// synchronously. (A dynamic import() here produced a runtime fetch of a
// non-web-accessible chunk → "chrome-extension://invalid" and no panel.)
import { defineContentScript } from "wxt/sandbox";
import { initContent } from "../src/content/index.js";

export default defineContentScript({
  matches: ["https://x.com/*", "https://twitter.com/*"],
  main() {
    initContent();
  },
});

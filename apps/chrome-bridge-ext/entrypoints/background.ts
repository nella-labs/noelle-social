// Thin wxt entrypoint — all logic lives in src/background/index.ts.
import { defineBackground } from "wxt/sandbox";
import "../src/background/index.js";

export default defineBackground(() => {
  // side-effect import above registers all listeners
});

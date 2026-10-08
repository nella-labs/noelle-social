// Build-time constant injected by wxt.config.ts (vite define): the ISO stamp of
// the build this bundle came from. Paired with .output/chrome-mv3/build-stamp.json
// (served by api-vm) so the running extension can detect a newer on-disk build
// and chrome.runtime.reload() itself.
declare const __BUILD_STAMP__: string;

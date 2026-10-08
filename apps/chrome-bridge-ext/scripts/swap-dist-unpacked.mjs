// Atomically refresh dist-unpacked/ (the Chrome "Load unpacked" path) from the
// fresh wxt build in .output/chrome-mv3, so Chrome never loads a half-written
// directory. Mirrors the LinkedIn actuator's build step (PR #450).
import fs from "node:fs";

const SRC = ".output/chrome-mv3";
const DEST = "dist-unpacked";

fs.rmSync(`${DEST}.new`, { recursive: true, force: true });
fs.cpSync(SRC, `${DEST}.new`, { recursive: true });
fs.rmSync(`${DEST}.old`, { recursive: true, force: true });
if (fs.existsSync(DEST)) fs.renameSync(DEST, `${DEST}.old`);
fs.renameSync(`${DEST}.new`, DEST);
fs.rmSync(`${DEST}.old`, { recursive: true, force: true });

import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";

/** Replace private state with a complete owner-readable file. */
export function writePrivateFile(file: string, body: string): void {
  const temporary = resolve(dirname(file), `.private.${randomBytes(12).toString("hex")}.tmp`);
  let created = false;
  try {
    writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
    created = true;
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } finally {
    if (created) rmSync(temporary, { force: true });
  }
}

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MAX_AGE_MINUTES } from "../src/content/notifications.js";

const here = dirname(fileURLToPath(import.meta.url));
const RUNTIME_CONST = join(here, "..", "..", "..", "packages", "runtime", "src", "notificationWindow.ts");
const MIGRATIONS = join(here, "..", "..", "..", "infra", "cloudsql", "schema");

/**
 * The notification window is one policy enforced in three places that cannot
 * import each other: this content script, the server's TypeScript, and the SQL
 * claim functions. It drifted on day one — the actuators shipped one number
 * while the server's claim RPC shipped another, from a parallel session. The
 * server silently won, so the operator's setting appeared to do nothing and
 * NOTHING ERRORED. That is the failure mode this file exists to make loud.
 */
describe("the recency window agrees with the server's", () => {
  const runtimeSrc = () => readFileSync(RUNTIME_CONST, "utf8");

  const runtimeHours = () => {
    const m = /NOTIFICATION_MAX_AGE_HOURS = (\d+)/.exec(runtimeSrc());
    expect(m, "packages/runtime/src/notificationWindow.ts must declare NOTIFICATION_MAX_AGE_HOURS").not.toBeNull();
    return Number(m![1]);
  };

  it("matches packages/runtime's NOTIFICATION_MAX_AGE_HOURS", () => {
    // A content script cannot import a workspace package, so this constant is
    // necessarily a copy. This is the test that makes the copy safe.
    expect(MAX_AGE_MINUTES).toBe(runtimeHours() * 60);
  });

  it("matches the newest notification-window migration", () => {
    // SQL cannot import either, so the migration holds its own copy. If the
    // constant moves without a matching migration, the server keeps enforcing
    // the OLD bound and silently overrides everything above it.
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const files = readdirSync(MIGRATIONS)
      .filter((f) => /notification_window_\d+h\.sql$/.test(f))
      .sort();
    expect(files.length, "expected at least one notification_window migration").toBeGreaterThan(0);

    const newest = files[files.length - 1]!;
    const declared = Number(/notification_window_(\d+)h\.sql$/.exec(newest)![1]);
    expect(declared, `${newest} names a different window than the shared constant`).toBe(runtimeHours());

    // …and the file's body must actually use that interval, not just be named it.
    const body = readFileSync(join(MIGRATIONS, newest), "utf8");
    const intervals = [...body.matchAll(/interval '(\d+) hours'/g)].map((m) => Number(m[1]));
    expect(intervals.length, `${newest} declares no 'N hours' interval`).toBeGreaterThan(0);
    for (const hours of intervals) expect(hours).toBe(runtimeHours());
  });
});

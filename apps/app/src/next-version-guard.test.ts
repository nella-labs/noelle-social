/**
 * Regression guard for the dead-button bug.
 *
 * Next.js 15.5.x ships an App Router <Link> regression: in production a left-
 * click fires the RSC navigation fetch but the client navigation never applies,
 * so every button/link on the page looks dead (right-click → "Open in new tab"
 * still works because the real <a href> is intact). It is NOT an app-code
 * hydration mismatch — an exhaustive root-cause sweep found every client
 * component already mount-guarded. See vercel/next.js #57565 and #88032.
 *
 * Downgrading off 15.5.x to a regression-free line is impossible: the HIGH
 * advisory GHSA-26hh-7cqf-hhc6 (App Router middleware/proxy bypass) is patched
 * only at 15.5.18+, so Vercel BLOCKS every 15.3/15.4 build as vulnerable. The
 * fix was therefore to upgrade onto the 16.x line (secure + App Router nav
 * overhaul), pinned at 16.2.6.
 *
 * This test fails loudly if someone relaxes the exact pin or drops back below
 * the secure 16.2.6 floor (which would reintroduce either the dead-<Link> bug
 * or the Vercel vulnerable-version deploy block). Moving the floor is a
 * conscious decision: verify <Link> navigation on a Vercel preview, then update
 * this guard.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { dependencies?: Record<string, string> };

const spec = pkg.dependencies?.next ?? "";

test("next is pinned to an exact version (no floating range)", () => {
  expect(
    /^\d+\.\d+\.\d+$/.test(spec),
    `next must be an exact version, got "${spec}"`,
  ).toBe(true);
});

test("next stays at/above the secure, regression-free 16.2.6 floor", () => {
  const [major, minor, patch] = spec.split(".").map((n) => parseInt(n, 10));
  const belowFloor =
    major < 16 || (major === 16 && (minor < 2 || (minor === 2 && patch < 6)));
  expect(
    belowFloor,
    `next@${spec} is below the 16.2.6 floor. The 15.5.x line has the App Router ` +
      `dead-<Link> regression, and everything below 15.5.18 is blocked by Vercel ` +
      `(GHSA-26hh-7cqf-hhc6). Stay on 16.2.6+, or only move after verifying <Link> ` +
      `navigation on a Vercel preview, then update this guard.`,
  ).toBe(false);
});

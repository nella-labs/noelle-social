import "server-only";

/**
 * Guided-panel dismissal, stored in a cookie rather than a column.
 *
 * `infra/cloudsql/` has no migration runner and no ledger — schema files are
 * hand-applied with `psql -f`. A `guided_dismissed_at` column would therefore
 * take the dashboard down for every org until a human ran the migration. A
 * cookie also scopes dismissal to the operator rather than the org, which is
 * the more correct scope: one teammate hiding the checklist should not hide it
 * for everyone else.
 *
 * The panel auto-hides once every required step is done, so this is an escape
 * hatch, not the primary path.
 */

import { cookies } from "next/headers";

const COOKIE = "noelle_guided_dismissed";
const MAX_AGE_S = 60 * 60 * 24 * 365;

function parse(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function isGuidedDismissed(orgSlug: string): Promise<boolean> {
  const jar = await cookies();
  return parse(jar.get(COOKIE)?.value).includes(orgSlug);
}

export async function setGuidedDismissed(orgSlug: string, dismissed: boolean): Promise<void> {
  const jar = await cookies();
  const current = new Set(parse(jar.get(COOKIE)?.value));
  if (dismissed) current.add(orgSlug);
  else current.delete(orgSlug);

  jar.set(COOKIE, [...current].join(","), {
    path: "/",
    maxAge: MAX_AGE_S,
    sameSite: "lax",
    httpOnly: true,
  });
}

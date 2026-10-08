// Skip-detail formatting for the reply submit path. These strings flow into
// noelle.reddit_activity.reason verbatim (as `reply-failed:<detail>`), so
// interpolated values scraped from the page (aria-labels, button text) are
// sanitized to a safe alphabet and the whole detail is length-capped — a
// quote/paren/unicode in a label must never corrupt the reason grammar the
// operator greps. Pure (no chrome.*) so it is unit-testable outside the SW.
// Mirrors the LinkedIn actuator's background/detail.ts (ports #442).
//
// Reason-grammar compatibility: every detail is appended AFTER the existing
// `reply-failed` prefix (`reply-failed:<detail>`), and the server-side health
// queries match `reason = 'challenge'` / `'throttle'` exactly — neither is
// touched by this suffix.

// Short build stamp appended to reply-failure reasons so a telemetry row
// self-identifies WHICH deployed build produced it — ending the "is the fix
// even loaded?" ambiguity when debugging live against a manually-reloaded
// unpacked extension (the exact pain point of the LinkedIn #444 hunt). Bump
// this string whenever the reply-submit / typing path changes.
// `rsub1` = the anchored submit locator + Input.insertText typing port.
// `rsub2` = rsub1 + the reg= region dump (every button in the composer climb
// region, so an icon-only / mis-ordered real submit shows in the failure row).
const BUILD = "rsub2";

const DETAIL_MAX = 120;
// The submit-not-found diagnostic carries per-bucket counts + the page path, so
// it gets a larger cap than the terse not-cleared line. reddit_activity.reason
// is unbounded text and the contracts schema is an unbounded optional string,
// so a longer reason is safe; the panel renders it via textContent (no markup).
const DIAG_MAX = 600;

/** What locateReplySubmit reports about the button it found (all optional:
 * an older content script still loaded in the tab sends none of it). */
export interface SubmitObserved {
  via?: unknown;
  text?: unknown;
  type?: unknown;
  slot?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Keep only [A-Za-z0-9 _-]; collapse whitespace runs (newlines first, so a
 * stripped '\n' doesn't glue two words together); trim. */
export function sanitizeDetailValue(v: string | undefined | null): string {
  return (v ?? "")
    .replace(/\s+/g, " ")
    .replace(/[^A-Za-z0-9 _-]+/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** A submit WAS clicked but the composer never cleared. Name the button so the
 * DB row says whether the click landed on the real submit or a decoy:
 * `not-cleared(via=<pass>,btn=<label>,type=<type-or-slot>)`. */
export function notClearedDetail(obs: SubmitObserved | undefined): string {
  const via = sanitizeDetailValue(str(obs?.via));
  const btn = sanitizeDetailValue(str(obs?.text));
  // type=submit vs slot=submit-button — whichever styling hook the button had.
  const type = sanitizeDetailValue(str(obs?.type) || str(obs?.slot));
  return `not-cleared(via=${via},btn=${btn},type=${type})`.slice(0, DETAIL_MAX);
}

/** The submit-search diagnostic (diagnoseReplySubmit); all optional — an
 * older content script still loaded in the tab sends none of it. */
export interface SubmitDiag {
  flavor?: unknown;
  scoped?: unknown;
  slots?: unknown;
  wf?: unknown;
  en?: unknown;
  vis?: unknown;
  top?: unknown;
  path?: unknown;
  region?: unknown;
}

const num = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? String(v) : "?");

/** No clickable submit ever appeared in the poll window. The composer read
 * tells the eras apart: box=absent → composer/page gone; box=present,empty=false
 * → the typed reply is still sitting there un-submittable. `lastSkip` is the
 * locator's final skipReason (reply-submit-not-found / reply-submit-disabled /
 * submit-zero-rect), and the search diagnostic splits the causes further:
 * `wf=0` = no eligible worded submit exists (selector model wrong), `en=0` = it
 * never enabled (typing/state), `en>0,vis=0` = enabled but no layout box yet;
 * `slots`/`scoped` say whether a slotted submit exists at all / in the target
 * comment's composer; `top=<label>_<why>` names the most telling candidate. */
export function submitNotFoundDetail(
  box: { present?: boolean; empty?: boolean } | null | undefined,
  lastSkip?: string,
  diag?: SubmitDiag | null,
): string {
  const present = box?.present === true;
  const empty = box?.empty === true;
  let s = `submit-not-found(b=${BUILD},box=${present ? "present" : "absent"},empty=${empty}`;
  const skip = sanitizeDetailValue(lastSkip);
  if (skip) s += `,last=${skip}`;
  if (diag) {
    const top = sanitizeDetailValue(str(diag.top));
    s += `,wf=${num(diag.wf)},en=${num(diag.en)},vis=${num(diag.vis)},slots=${num(diag.slots)},scoped=${num(diag.scoped)},top=${top}`;
    const path = sanitizeDetailValue(str(diag.path).replace(/\//g, "-"));
    if (path) s += `,path=${path}`;
    // reg= goes LAST: the region dump is the expendable field, so if DIAG_MAX
    // truncates the tail it's the button dump that's clipped, never the
    // per-bucket counts / path (matches linkedin's dom-before-reg convention).
    const region = sanitizeDetailValue(str(diag.region));
    if (region) s += `,reg=${region}`;
  }
  return `${s})`.slice(0, DIAG_MAX);
}

// Skip-detail formatting for the reply submit path. These strings flow into
// noelle.x_activity.reason verbatim (as `reply-failed:<detail>`), so
// interpolated values scraped from the page (aria-labels, button text) are
// sanitized to a safe alphabet and the whole detail is length-capped — a
// quote/paren/unicode in a label must never corrupt the reason grammar the
// operator greps. Pure (no chrome.*) so it is unit-testable outside the SW.
// (Ported from the LinkedIn actuator's background/detail.ts, #442/#444.)

// Short build stamp appended to reply-failure reasons so a telemetry row
// self-identifies WHICH deployed build produced it — ending the "is the fix
// even loaded?" ambiguity when debugging live against a manually-reloaded
// unpacked extension. Bump this string whenever the reply-submit / typing
// path changes. `xtx1` = the initial port: composer-anchored submit locator,
// Input.insertText typing (React editor model sync), confirm-cleared submit.
const BUILD = "xtx1";

const DETAIL_MAX = 120;
// The submit-not-found diagnostic carries the editor DOM descriptor + a per-
// button region dump, so it gets a larger cap than the terse not-cleared line.
// x_activity.reason is an unbounded optional string in the contracts schema,
// so a longer reason is safe; the panel renders it via textContent (no markup).
const DIAG_MAX = 600;

/** What locateCommentSubmit reports about the button it found (all optional:
 * an older content script still loaded in the tab sends none of it). */
export interface SubmitObserved {
  via?: unknown;
  aria?: unknown;
  text?: unknown;
  type?: unknown;
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
 * `not-cleared(via=<pass>,btn=<aria-or-text>,type=<type>)`. */
export function notClearedDetail(obs: SubmitObserved | undefined): string {
  const via = sanitizeDetailValue(str(obs?.via));
  // aria over text: the accessible name is the more stable descriptor.
  const btn = sanitizeDetailValue(str(obs?.aria) || str(obs?.text));
  const type = sanitizeDetailValue(str(obs?.type));
  return `not-cleared(via=${via},btn=${btn},type=${type})`.slice(0, DETAIL_MAX);
}

/** The submit-search diagnostic (diagnoseCommentSubmit); all optional — an
 * older content script still loaded in the tab sends none of it. */
export interface SubmitDiag {
  wf?: unknown;
  en?: unknown;
  vis?: unknown;
  all?: unknown;
  top?: unknown;
  region?: unknown;
  dom?: unknown;
}

const num = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? String(v) : "?");

/** No clickable submit ever appeared in the poll window. The composer read
 * tells the eras apart (box=absent → composer/page gone; box=present,empty=false
 * → the reply is still sitting there un-submittable), and the search diagnostic
 * splits the three causes of "un-submittable":
 *   wf   = worded submit candidates that follow the box (the locator's pool)
 *   en   = of those, how many were enabled
 *   vis  = of the enabled ones, how many had a clickable (non-zero) rect
 *   top  = the most telling candidate + why it was rejected
 * so `wf=0` = no worded submit exists (selector model wrong), `en=0` = it never
 * enabled (typing/state), `en>0,vis=0` = enabled but no layout box yet. */
export function submitNotFoundDetail(
  box: { present?: boolean; empty?: boolean } | null | undefined,
  diag?: SubmitDiag | null,
): string {
  const present = box?.present === true;
  const empty = box?.empty === true;
  let s = `submit-not-found(b=${BUILD},box=${present ? "present" : "absent"},empty=${empty}`;
  if (diag) {
    const top = sanitizeDetailValue(str(diag.top));
    s += `,wf=${num(diag.wf)},en=${num(diag.en)},vis=${num(diag.vis)},all=${num(diag.all)},top=${top}`;
    // dom= before reg= so the editor descriptor is never the part truncated.
    const dom = sanitizeDetailValue(str(diag.dom));
    if (dom) s += `,dom=${dom}`;
    const region = sanitizeDetailValue(str(diag.region));
    if (region) s += `,reg=${region}`;
  }
  return `${s})`.slice(0, DIAG_MAX);
}

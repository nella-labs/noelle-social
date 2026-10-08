// A small pill on a LinkedIn (Lyra) reply card showing which writing STYLE
// shaped the draft. Two states:
//   • styleSource present → the Account-Feeder blend of fed accounts whose FORM
//     was imitated, e.g. "Style: kaia 75% · devon 25%" (single source drops the
//     percent: "Style: kaia").
//   • styleSource null/empty → the operator's base voice only: "Style: Mars".
// The base voice (Mars) is always on; a fed blend layers FORM on top of it, so
// the tooltip spells that out. See drafter `buildStyleSource` + the api-vm
// outbound route that persists `style_source` onto each draft payload.

import type { CSSProperties } from "react";

export type StyleSource = { blend: Array<{ handle: string; weight: number }> } | null;

/** The label name for the operator's own base voice (the Mars Obsidian vault). */
const BASE_VOICE = "Mars";

/**
 * LinkedIn vanity slugs often carry an auto-generated id suffix
 * (`kaia-tham-7bb065343`). Strip a trailing `-<hex id>` so the badge reads
 * `kaia-tham`, not the raw slug. Plain handles (`annielongg`, `devon`) and
 * legit multi-word slugs without a hex tail are left untouched.
 */
export function prettyHandle(handle: string): string {
  return handle.replace(/-[0-9a-f]{6,}$/i, "");
}

export function formatStyleBlend(blend: Array<{ handle: string; weight: number }>): string {
  const parts = blend
    .filter((b) => b.handle.trim().length > 0)
    .map((b) => {
      const pct = Math.round(b.weight * 100);
      const name = prettyHandle(b.handle.trim());
      // A lone source is effectively 100% — the percent is noise, so drop it.
      return blend.length === 1 ? name : `${name} ${pct}%`;
    });
  return parts.join(" · ");
}

export function StyleSourceBadge({
  styleSource,
  className = "tag",
  style,
}: {
  styleSource: StyleSource;
  /** Defaults to the neutral `.tag` pill; callers can theme via tag variants. */
  className?: string;
  style?: CSSProperties;
}) {
  const blend = styleSource?.blend?.filter((b) => b.handle.trim().length > 0) ?? [];

  if (blend.length === 0) {
    return (
      <span
        className={className}
        style={style}
        title="Operator base voice only — no fed-account style was applied to this reply."
      >
        Style: {BASE_VOICE}
      </span>
    );
  }

  return (
    <span
      className={className}
      style={style}
      title={`Account Feeder: this reply's form was shaped by ${formatStyleBlend(
        blend,
      )}, layered on the operator's base voice (${BASE_VOICE}).`}
    >
      Style: {formatStyleBlend(blend)}
    </span>
  );
}

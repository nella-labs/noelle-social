"use client";

import { useState, useTransition } from "react";
import { setPinnedStyle } from "@/app/app/[orgSlug]/agents/[instanceId]/feeder/actions";

export interface StyleSourceOption {
  handle: string;
  displayName: string | null;
}

/** Human label for a source: its display name, else the handle minus the LinkedIn hex suffix. */
function label(s: StyleSourceOption): string {
  return s.displayName?.trim() || s.handle.replace(/-[0-9a-f]{6,}$/i, "");
}

/**
 * Pin the LinkedIn post drafter to one ingested style source ("write in this exact
 * person's style"). Selecting a person grounds every draft's STYLE block in ONLY
 * that account's real posts + ultra profile; "Automatic" restores the blended
 * default. Mirrors what typing "follow Kaia's style" in the drafter chat does —
 * this is the explicit, visible control for the same lever. Applies on the
 * drafter's next tick.
 */
export function StylePicker({
  orgSlug,
  instanceId,
  sources,
  current,
}: {
  orgSlug: string;
  instanceId: string;
  sources: StyleSourceOption[];
  current: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<string>(current ?? "");
  const [status, setStatus] = useState<string | null>(null);

  function change(next: string) {
    setValue(next);
    setStatus(null);
    startTransition(async () => {
      const res = await setPinnedStyle({ orgSlug, instanceId, handle: next || null });
      if (res.ok) {
        const chosen = sources.find((s) => s.handle === next);
        setStatus(chosen ? `Writing in ${label(chosen)}'s style.` : "Back to automatic style.");
      } else {
        setStatus(`Couldn't save: ${res.error.message}`);
        setValue(current ?? ""); // revert the control on failure
      }
    });
  }

  return (
    <div className="style-picker clay">
      <span className="eyebrow">Post style</span>
      <p className="ink-muted" style={{ fontSize: 12, margin: "2px 0 6px" }}>
        Write in a specific person&apos;s style — grounded in their actual posts.
      </p>
      <select
        className="input"
        style={{ width: "100%", fontSize: 13, cursor: "pointer" }}
        value={value}
        disabled={pending}
        onChange={(e) => change(e.target.value)}
        aria-label="Post style source"
      >
        <option value="">Automatic (blended)</option>
        {sources.map((s) => (
          <option key={s.handle} value={s.handle}>
            {label(s)}
          </option>
        ))}
      </select>
      {status && (
        <span className="mono" style={{ fontSize: 11, display: "block", marginTop: 6 }}>
          {status}
        </span>
      )}
    </div>
  );
}

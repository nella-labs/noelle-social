"use client";

import { useState, useTransition } from "react";
import { setStyleExemplarKinds } from "./actions";

type Mode = "posts" | "both";

const KINDS: Record<Mode, ("post" | "comment")[]> = {
  posts: ["post"],
  both: ["post", "comment"],
};

/**
 * Choose which of a style source's corpus shapes Lyra's replies: their original
 * POSTS only (default — their considered voice) or posts + their authored
 * comments (often sloppy). Writes account_feeder_config.styleExemplarKinds via
 * the setStyleExemplarKinds server action; the drafter reads it on its next tick,
 * no restart. Comments-only isn't offered (there's no reason to shape a reply
 * from throwaway comments while ignoring the posts).
 */
export function StyleKindToggle({
  orgSlug,
  instanceId,
  current,
}: {
  orgSlug: string;
  instanceId: string;
  current: Mode;
}) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<Mode>(current);
  const [status, setStatus] = useState<string | null>(null);

  function change(next: Mode) {
    setValue(next);
    setStatus(null);
    startTransition(async () => {
      const res = await setStyleExemplarKinds({ orgSlug, instanceId, kinds: KINDS[next] });
      if (res.ok) {
        setStatus(
          next === "posts"
            ? "Replies now shaped by your sources' posts only."
            : "Replies now shaped by your sources' posts + comments.",
        );
      } else {
        setStatus(`Couldn't save: ${res.error.message}`);
        setValue(current); // revert on failure
      }
    });
  }

  return (
    <div className="clay" style={{ padding: 16 }}>
      <span className="eyebrow">Shape replies from</span>
      <p className="ink-muted" style={{ fontSize: 12, margin: "2px 0 8px" }}>
        Original posts are a person&apos;s considered voice; their comments are
        often sloppy. Posts-only is recommended.
      </p>
      <select
        className="input"
        style={{ width: "100%", maxWidth: 320, fontSize: 13, cursor: "pointer" }}
        value={value}
        disabled={pending}
        onChange={(e) => change(e.target.value as Mode)}
        aria-label="Which corpus shapes replies"
      >
        <option value="posts">Posts only (recommended)</option>
        <option value="both">Posts + their comments</option>
      </select>
      {status && (
        <span className="mono" style={{ fontSize: 11, display: "block", marginTop: 6 }}>
          {status}
        </span>
      )}
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { linkVideoDraftToClip } from "../video-watchlist-actions";
import type { LinkableDraft } from "@/lib/video-analytics-queries";

// Per-post "which Nova draft did I use" control. Shows the linked draft hook, or
// a picker (best caption match pre-selected) so the operator can attribute a
// published post to the draft it came from — Nova is draft-only, so this link is
// what makes "which drafts I used" real.

export function PostAttribution({
  orgSlug,
  instanceId,
  clipId,
  draftId,
  draftHook,
  drafts,
  suggestedDraftId,
}: {
  orgSlug: string;
  instanceId: string;
  clipId: string;
  draftId: string | null;
  draftHook: string | null;
  drafts: LinkableDraft[];
  suggestedDraftId: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string>(draftId ?? suggestedDraftId ?? "");

  const save = (next: string | null) =>
    start(async () => {
      const res = await linkVideoDraftToClip({ orgSlug, instanceId, clipId, draftId: next });
      if (res.ok) {
        setOpen(false);
        router.refresh();
      }
    });

  if (draftId && !open) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ok, #2e7d32)" }}>◆ from draft</span>
        <span style={{ fontSize: 11.5, color: "var(--ink-muted)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {draftHook ?? "(untitled)"}
        </span>
        <button className="btn btn-xs btn-ghost" onClick={() => setOpen(true)} disabled={pending}>change</button>
      </div>
    );
  }

  if (!open) {
    return (
      <button className="btn btn-xs btn-ghost" onClick={() => setOpen(true)} disabled={pending} style={{ opacity: 0.85 }}>
        + link a draft
      </button>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <select
        value={sel}
        onChange={(e) => setSel(e.target.value)}
        style={{ maxWidth: 240, height: 28, borderRadius: 7, border: 0, background: "var(--paper-2)", boxShadow: "0 0 0 0.5px var(--rule)", fontSize: 11.5, color: "var(--ink)", padding: "0 8px" }}
      >
        <option value="">— none —</option>
        {drafts.map((d) => (
          <option key={d.id} value={d.id}>
            {(d.hook ?? "(untitled)").slice(0, 60)}{d.id === suggestedDraftId ? "  ✦ likely" : ""}
          </option>
        ))}
      </select>
      <button className="btn btn-xs btn-accent" onClick={() => save(sel || null)} disabled={pending}>{pending ? "…" : "Save"}</button>
      <button className="btn btn-xs btn-ghost" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
    </div>
  );
}

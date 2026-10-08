"use client";

import { useMemo, useState, useTransition } from "react";
import { remotionAssetFromGraphSpec, type RemotionAssetSpec } from "@noelle/contracts";
import { removeDraftVisual, updateDraftVisual } from "@/app/app/[orgSlug]/studio/actions";
import { VisualPreview } from "./remotion/VisualPreview";

// Visual building blocks for Nova's draft storyboard: render one AI graph_spec
// as a live Remotion preview with Refine (title + brand colour) + Remove, plus
// helpers to place a visual on the timeline and pull footage cues from text.

export type LooseSpec = Record<string, unknown> & { brandColor?: string; tStart?: number };

/** Coerce one loose graph_spec → typed RemotionAssetSpec, applying a stored brandColor override. */
export function toRenderable(raw: LooseSpec): RemotionAssetSpec | null {
  const spec = remotionAssetFromGraphSpec(raw);
  if (!spec) return null;
  return typeof raw.brandColor === "string" ? ({ ...spec, brandColor: raw.brandColor } as RemotionAssetSpec) : spec;
}

const FOOTAGE_CUE = /\[([^\]]{2,80})\]/g;

/** Pull bracket footage/visual cues — e.g. [B-ROLL: …], [SCREEN RECORDING], [GRAPHIC] — from text. */
export function footageCues(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(FOOTAGE_CUE);
  while ((m = re.exec(text)) !== null) out.push(m[1].trim());
  return out;
}

/**
 * The second a visual appears on screen — from a structured `tStart` if the
 * scripter emitted one, else parsed from the prose `note` ("at 0:21", "first
 * 3-4 seconds"). null when it can't be placed (→ shown in an "unplaced" bucket).
 */
export function graphSpecSeconds(raw: LooseSpec): number | null {
  if (typeof raw.tStart === "number" && Number.isFinite(raw.tStart)) return raw.tStart;
  const note = typeof raw.note === "string" ? raw.note : "";
  const mmss = note.match(/(\d+):(\d{2})/);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  const secs = note.match(/\bat\s+(\d+)\s*s(?:ec)?/i);
  if (secs) return Number(secs[1]);
  if (/\bfirst\b/i.test(note) || /\bopen(ing|s)?\b/i.test(note)) return 0;
  return null;
}

export function VisualCard({
  orgSlug,
  draftId,
  index,
  raw,
}: {
  orgSlug: string;
  draftId: string;
  index: number;
  raw: LooseSpec;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(typeof raw.title === "string" ? raw.title : "");
  const [color, setColor] = useState(typeof raw.brandColor === "string" ? raw.brandColor : "#B4471E");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState("");

  // Live preview reflects the in-progress edits without a round trip.
  const previewSpec = useMemo(
    () => toRenderable({ ...raw, title: title || raw.title, brandColor: color }),
    [raw, title, color],
  );

  if (!previewSpec) {
    // Non-renderable spec (e.g. a "stat"/"other" suggestion) — show as a chip.
    const kind = String(raw.kind ?? "visual");
    const t = typeof raw.title === "string" ? raw.title : "";
    return (
      <span className="tag" style={{ alignSelf: "flex-start" }}>
        {kind}
        {t ? ` · ${t}` : ""} (suggestion)
      </span>
    );
  }

  const save = () =>
    start(async () => {
      setMsg("");
      const r = await updateDraftVisual({ orgSlug, draftId, index, title, brandColor: color });
      if (r.ok) {
        setEditing(false);
      } else {
        setMsg("Couldn’t save — try again.");
      }
    });

  const remove = () =>
    start(async () => {
      setMsg("");
      const r = await removeDraftVisual({ orgSlug, draftId, index });
      if (!r.ok) setMsg("Couldn’t remove — try again.");
    });

  return (
    <div style={{ width: 188 }}>
      <VisualPreview spec={previewSpec} width={188} />
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-soft)" }}>
          {previewSpec.kind.replace("_", " ")}
        </span>
        <button
          type="button"
          className="btn btn-xs"
          style={{ marginLeft: "auto" }}
          disabled={pending}
          onClick={() => setEditing((e) => !e)}
        >
          {editing ? "Close" : "Refine"}
        </button>
        <button type="button" className="btn btn-xs btn-ghost" disabled={pending} onClick={remove}>
          Remove
        </button>
      </div>

      {editing ? (
        <div className="clay-flat" style={{ marginTop: 8, padding: 9, borderRadius: 10, display: "grid", gap: 7 }}>
          <label style={{ fontSize: 10, color: "var(--ink-muted)" }}>
            Title
            <input
              className="input"
              style={{ marginTop: 3, height: 28, fontSize: 12 }}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Overlay title"
            />
          </label>
          <label style={{ fontSize: 10, color: "var(--ink-muted)", display: "flex", alignItems: "center", gap: 8 }}>
            Brand colour
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 34, height: 26, border: "none", background: "none" }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{color}</span>
          </label>
          <button type="button" className="btn btn-xs btn-primary" disabled={pending} onClick={save}>
            {pending ? "Saving…" : "Save changes"}
          </button>
        </div>
      ) : null}
      {msg ? <div style={{ fontSize: 10, color: "var(--danger)", marginTop: 4 }}>{msg}</div> : null}
    </div>
  );
}

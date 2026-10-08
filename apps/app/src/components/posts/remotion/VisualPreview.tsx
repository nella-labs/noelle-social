"use client";

import { Player } from "@remotion/player";
import { useEffect, useState } from "react";
import type { RemotionAssetSpec } from "@noelle/contracts";
import { VisualComposition, DraftReel, draftReelDuration, VIDEO_W, VIDEO_H, VIDEO_FPS } from "./compositions";

// Player wants a component typed over Record<string, unknown> inputProps. Wrap
// VisualComposition so the spec rides through with its real type intact.
function PlayerComposition({ spec }: { spec: RemotionAssetSpec }) {
  return <VisualComposition spec={spec} />;
}

function ReelComposition({ specs, hook }: { specs: RemotionAssetSpec[]; hook?: string }) {
  return <DraftReel specs={specs} hook={hook} />;
}

/**
 * Live preview of the whole draft as a vertical reel — the hook caption then
 * each visual in sequence. The right-pane "Live preview" of a video draft.
 */
export function ReelPreview({ specs, hook, width = 270 }: { specs: RemotionAssetSpec[]; hook?: string; width?: number }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const height = Math.round((width * VIDEO_H) / VIDEO_W);
  const box = { width, height, borderRadius: 16, overflow: "hidden", boxShadow: "0 0 0 1px var(--rule)", background: "#000" } as const;
  if (!mounted) return <div style={{ ...box, background: "var(--paper-2)" }} aria-hidden />;
  return (
    <Player
      component={ReelComposition}
      inputProps={{ specs, hook }}
      durationInFrames={draftReelDuration(specs, hook)}
      compositionWidth={VIDEO_W}
      compositionHeight={VIDEO_H}
      fps={VIDEO_FPS}
      style={box}
      controls
      loop
      autoPlay
    />
  );
}

/**
 * Live in-browser preview of one Nova overlay (via @remotion/player) — the
 * actual rendered visual, scrubbable + looping, right inside the draft. Mounts
 * client-side only (Player needs the DOM); shows a placeholder until then.
 */
export function VisualPreview({ spec, width = 188 }: { spec: RemotionAssetSpec; width?: number }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const height = Math.round((width * VIDEO_H) / VIDEO_W);
  const box = { width, height, borderRadius: 10, overflow: "hidden", boxShadow: "0 0 0 1px var(--rule)" } as const;
  if (!mounted) {
    return <div style={{ ...box, background: "var(--paper-2)" }} aria-hidden />;
  }
  return (
    <Player
      component={PlayerComposition}
      inputProps={{ spec }}
      durationInFrames={spec.durationFrames}
      compositionWidth={VIDEO_W}
      compositionHeight={VIDEO_H}
      fps={VIDEO_FPS}
      style={box}
      controls
      loop
      autoPlay
    />
  );
}

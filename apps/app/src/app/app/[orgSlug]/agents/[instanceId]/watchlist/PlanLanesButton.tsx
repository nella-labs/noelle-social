"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { planVideoNicheLanes } from "../video-watchlist-actions";

// "Plan lanes from objective" — the objective-driven move (like Lyra/Vega). Asks
// Nova to expand the instance objective into niche/hashtag discovery lanes that
// supplement the operator's manual ones, then refreshes so they appear in the
// list. Client component so the operator gets real feedback (added N / set an
// objective first / couldn't plan), which a fire-and-forget server-action form
// can't surface.

const MESSAGES: Record<string, string> = {
  no_objective: "Give Nova an objective first, then plan lanes from it.",
  empty: "Couldn’t plan lanes from the objective — try again.",
  forbidden: "Not allowed.",
  not_found: "Agent not found.",
  unauthenticated: "Please sign in again.",
};

export function PlanLanesButton({
  orgSlug,
  instanceId,
  platform: initialPlatform = "instagram",
  hasObjective,
}: {
  orgSlug: string;
  instanceId: string;
  platform?: "instagram" | "tiktok";
  hasObjective: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // The niche list is mixed-platform, so let the operator pick which network to
  // plan lanes for. Objective-planning already supports TikTok end-to-end
  // (planVideoNicheLanes → planNicheLanes); this just surfaces the choice.
  const [platform, setPlatform] = useState<"instagram" | "tiktok">(initialPlatform);

  function run() {
    setNote(null);
    start(async () => {
      const res = await planVideoNicheLanes({ orgSlug, instanceId, platform });
      const net = platform === "tiktok" ? "TikTok" : "Instagram";
      if (res.ok) {
        setNote(
          res.added.length
            ? { kind: "ok", text: `Added ${res.added.length} ${net} lane${res.added.length === 1 ? "" : "s"} from your objective.` }
            : { kind: "ok", text: `No new ${net} lanes — your objective is already well covered.` },
        );
        router.refresh();
      } else {
        setNote({ kind: "err", text: MESSAGES[res.error] ?? "Couldn’t plan lanes." });
      }
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <select
          aria-label="Platform to plan niche lanes for"
          className="input"
          style={{ flex: "0 0 96px", fontSize: 11, padding: "3px 6px" }}
          value={platform}
          onChange={(e) => setPlatform(e.target.value === "tiktok" ? "tiktok" : "instagram")}
          disabled={pending || !hasObjective}
        >
          <option value="instagram">Instagram</option>
          <option value="tiktok">TikTok</option>
        </select>
        <button
          type="button"
          className="btn btn-xs"
          onClick={run}
          disabled={pending || !hasObjective}
          title={hasObjective ? "Expand your objective into niche lanes" : "Set an objective on this agent first"}
        >
          {pending ? "Planning…" : "✦ Plan from objective"}
        </button>
      </div>
      {note ? (
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            maxWidth: 220,
            textAlign: "right",
            color: note.kind === "ok" ? "var(--ink-soft)" : "var(--rust, #b4541f)",
          }}
        >
          {note.text}
        </span>
      ) : null}
    </div>
  );
}

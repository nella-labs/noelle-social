"use client";

import { useMemo, useState, useTransition } from "react";
import type { PostIdeaRow } from "@/lib/posts-queries";
import { generatePost, replacePostIdea } from "@/app/app/[orgSlug]/approvals/posts/actions";
import { AutoRefresh } from "@/app/app/[orgSlug]/approvals/AutoRefresh";
import { LANE_BY_ID } from "./content-lanes";

/**
 * The Compose review board — the "see ideas first, then approve or kill, and a
 * replacement appears" flow. Renders this instance's `proposed` ideas as cards:
 *
 *   Approve → generatePost (proposed→approved; the post-drafter drafts it, and it
 *             shows on the Drafts board).
 *   Kill    → replacePostIdea (dismiss + queue ONE replacement on the same theme;
 *             the fresh idea surfaces on the next refresh).
 *
 * Optimistic: approved/killed cards leave immediately; a light AutoRefresh pulls
 * in replacements + any newly-generated ideas without a manual reload.
 */
export function ComposeReviewBoard({
  orgSlug,
  ideas,
  platform,
  laneColor,
  agent,
}: {
  orgSlug: string;
  ideas: PostIdeaRow[];
  platform: string;
  laneColor: string;
  agent: string;
}) {
  const [pending, start] = useTransition();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [replacing, setReplacing] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);

  const proposed = useMemo(
    () => ideas.filter((i) => i.status === "proposed" && !hidden.has(i.id)),
    [ideas, hidden],
  );

  function hide(id: string) {
    setHidden((s) => new Set(s).add(id));
  }

  function approve(id: string) {
    hide(id);
    setMsg(null);
    start(async () => {
      const res = await generatePost({ orgSlug, ideaId: id });
      if (!res.ok) {
        setMsg(`Couldn't approve: ${res.error.message}`);
        setHidden((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
      } else {
        setMsg("Approved — drafting it now. It'll land on the Drafts board.");
      }
    });
  }

  function kill(id: string) {
    hide(id);
    setReplacing((n) => n + 1);
    setMsg(null);
    start(async () => {
      const res = await replacePostIdea({ orgSlug, ideaId: id });
      setReplacing((n) => Math.max(0, n - 1));
      if (!res.ok) {
        setMsg(`Couldn't replace: ${res.error.message}`);
        setHidden((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
      } else {
        setMsg("Killed — finding a fresh angle on the same theme…");
      }
    });
  }

  if (proposed.length === 0 && replacing === 0) {
    return (
      <div className="card clay-flat" style={{ padding: 26, textAlign: "center" }}>
        <div className="serif" style={{ fontSize: 18, marginBottom: 6 }}>No ideas to review yet</div>
        <div style={{ color: "var(--ink-muted)", fontSize: 13, maxWidth: "52ch", margin: "0 auto" }}>
          Plan a batch above and {agent} proposes hooks here — approve the ones you like (it drafts them),
          kill the ones you don&apos;t (a fresh angle takes its place).
        </div>
        <AutoRefresh intervalMs={15_000} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span className="serif" style={{ fontSize: 18 }}>Review the ideas</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-muted)" }}>
            {proposed.length} to review{replacing > 0 ? ` · ${replacing} replacing…` : ""}
          </span>
        </div>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-soft)" }}>
          approve → drafts · kill → new one appears
        </span>
      </div>

      {msg && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--ink-muted)", marginBottom: 12 }}>{msg}</div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
        {proposed.map((idea) => (
          <ReviewCard
            key={idea.id}
            idea={idea}
            laneColor={laneColor}
            busy={pending}
            onApprove={() => approve(idea.id)}
            onKill={() => kill(idea.id)}
          />
        ))}
        {Array.from({ length: replacing }, (_, i) => (
          <ReplacingCard key={`r${i}`} laneColor={laneColor} />
        ))}
      </div>

      <AutoRefresh intervalMs={12_000} />
    </div>
  );
}

function ReviewCard({
  idea,
  laneColor,
  busy,
  onApprove,
  onKill,
}: {
  idea: PostIdeaRow;
  laneColor: string;
  busy: boolean;
  onApprove: () => void;
  onKill: () => void;
}) {
  const lane = LANE_BY_ID[idea.platform] ?? LANE_BY_ID.x;
  const color = lane?.color ?? laneColor;
  return (
    <div className="card" style={{ padding: 16, position: "relative", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <span
          style={{
            fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase",
            color, padding: "2px 7px", borderRadius: 999,
            background: `color-mix(in oklch, ${color} 12%, var(--paper))`,
            boxShadow: `0 0 0 0.5px color-mix(in oklch, ${color} 35%, var(--rule))`,
          }}
        >
          {lane?.label ?? idea.platform}
        </span>
        {idea.pillar && <span className="tag" style={{ height: 18 }}>{idea.pillar}</span>}
        {idea.angle && <span className="tag" style={{ height: 18 }}>{idea.angle}</span>}
      </div>

      <div className="serif" style={{ fontSize: 17, lineHeight: 1.25, color: "var(--ink)" }}>{idea.hook}</div>

      {idea.thesis && (
        <div style={{ marginTop: 9, fontSize: 11.5, color: "var(--ink-muted)", lineHeight: 1.45, display: "flex", gap: 6 }}>
          <span style={{ color: "var(--accent)", flexShrink: 0 }}>◆</span>
          <span>{idea.thesis}</span>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: "auto", paddingTop: 14 }}>
        <button className="btn btn-sm btn-primary" style={{ flex: 1 }} onClick={onApprove} disabled={busy}>
          Approve →
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onKill} disabled={busy} title="Kill this idea — a fresh one takes its place">
          Kill ↻
        </button>
      </div>
    </div>
  );
}

function ReplacingCard({ laneColor }: { laneColor: string }) {
  return (
    <div
      className="card"
      style={{
        padding: 16, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        minHeight: 150, gap: 8, borderStyle: "dashed",
        boxShadow: `0 0 0 1px color-mix(in oklch, ${laneColor} 30%, var(--rule))`,
        background: `color-mix(in oklch, ${laneColor} 4%, var(--paper-2))`,
      }}

"use client";

import { useState, useTransition } from "react";
import { createComposeJobAction } from "@/app/app/[orgSlug]/content/schedule-actions";
import { triggerIdeation } from "@/app/app/[orgSlug]/approvals/posts/actions";

const MAX_ITEMS = 200;
// Ideation single-mode caps at 10 ideas per round; you review a round, then
// generate more. (The plan sizing below is the ambition; each round tops out here.)
const REVIEW_ROUND_MAX = 10;

/**
 * The Compose planner. For X + LinkedIn it's REVIEW-FIRST: "N a day for M weeks"
 * sizes the ambition, and the button GENERATES a round of ideas (≤10) you approve
 * or kill below — nothing is scheduled until you approve. For Reddit/Video it
 * keeps the direct batch-schedule (they don't run post-ideation).
 */
export function ComposeForm({
  orgSlug,
  instanceId,
  platform,
  canAutoPost,
  laneColor,
  today,
}: {
  orgSlug: string;
  instanceId: string;
  platform: string;
  canAutoPost: boolean;
  laneColor: string;
  today: string;
}) {
  const reviewMode = platform === "x" || platform === "linkedin";
  const [perDay, setPerDay] = useState(3);
  const [weeks, setWeeks] = useState(2);
  const [topic, setTopic] = useState("");
  const [autoPublish, setAutoPublish] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const total = perDay * weeks * 7;
  const over = total > MAX_ITEMS;
  const roundCount = Math.min(total, REVIEW_ROUND_MAX);

  function submit() {
    if (over) return;
    setMsg(null);
    start(async () => {
      try {
        if (reviewMode) {
          const res = await triggerIdeation({
            orgSlug,
            instanceId,
            mode: "single",
            count: roundCount,
            topics: topic.trim() ? [topic.trim()] : undefined,
            platform: platform as "x" | "linkedin",
          });
          if (!res.ok) {
            setMsg({ ok: false, text: `Couldn't generate ideas: ${res.error.message}` });
            return;
          }
          setMsg({
            ok: true,
            text: `Generating ${roundCount} idea${roundCount === 1 ? "" : "s"} to review below — approve the keepers, kill the rest.`,
          });
          return;
        }
        const out = await createComposeJobAction(orgSlug, {
          instanceId,
          platform,
          perDay,
          days: weeks * 7,
          startDate: today,
          topic: topic.trim() || undefined,
          autoPublish: canAutoPost ? autoPublish : false,
        });
        setMsg({ ok: true, text: `Planned ${out.items_total} posts — they'll fill the calendar as drafts for your review.` });
      } catch (e) {
        setMsg({ ok: false, text: `Couldn't ${reviewMode ? "generate" : "schedule"}: ${(e as Error).message}` });
      }
    });
  }

  return (
    <div className="card clay-flat" style={{ padding: 18 }}>
      {/* Sentence-style plan input */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, fontSize: 16, color: "var(--ink-2)" }}>
        <span className="serif" style={{ fontSize: 18 }}>Plan</span>
        <NumberStepper value={perDay} min={1} max={50} onChange={setPerDay} />
        <span>{perDay === 1 ? "post a day" : "posts a day"} for</span>
        <NumberStepper value={weeks} min={1} max={12} onChange={setWeeks} />
        <span>{weeks === 1 ? "week" : "weeks"}</span>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 12,
            color: over ? "var(--bad, oklch(0.6 0.18 25))" : "var(--ink-muted)",
            marginLeft: 4,
          }}
        >
          = {total} posts{over ? ` (max ${MAX_ITEMS})` : ""}
        </span>
      </div>

      <textarea
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        placeholder="Optional — a theme or angle to steer the ideas (e.g. 'distribution lessons for indie hackers')"
        rows={2}
        style={{
          width: "100%",
          marginTop: 14,
          padding: "10px 12px",
          borderRadius: 10,
          border: "none",
          boxShadow: "0 0 0 0.5px var(--rule)",
          background: "var(--paper)",
          color: "var(--ink)",
          fontSize: 13.5,
          lineHeight: 1.5,
          resize: "vertical",
          fontFamily: "inherit",
        }}
      />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
        {reviewMode ? (
          <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>
            You review every idea before anything is scheduled{total > REVIEW_ROUND_MAX ? ` — ${REVIEW_ROUND_MAX} at a time` : ""}.
          </span>
        ) : canAutoPost ? (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--ink-2)", cursor: "pointer" }}>
            <input type="checkbox" checked={autoPublish} onChange={(e) => setAutoPublish(e.target.checked)} />
            Auto-publish at each slot (within your daily cap)
          </label>
        ) : (
          <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>
            Drafts only — you post these by hand from the calendar.
          </span>
        )}
        <button
          type="button"
          className="btn btn-primary"
          onClick={submit}
          disabled={over || pending}
          style={{ opacity: over || pending ? 0.6 : 1, boxShadow: `0 0 0 1px ${laneColor}` }}
        >
          {pending
            ? reviewMode ? "Generating…" : "Planning…"
            : reviewMode ? `Generate ${roundCount} ideas →` : `Plan ${total} posts →`}
        </button>
      </div>

      {msg ? (
        <div
          style={{
            marginTop: 12,
            fontSize: 13,
            color: msg.ok ? "var(--ok)" : "var(--bad, oklch(0.6 0.18 25))",
          }}
        >
          {msg.text}
        </div>
      ) : null}
    </div>
  );
}

function NumberStepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 2, background: "var(--paper)", borderRadius: 9, boxShadow: "0 0 0 0.5px var(--rule)", padding: 2 }}>
      <StepBtn label="−" onClick={() => onChange(Math.max(min, value - 1))} />
      <span style={{ minWidth: 22, textAlign: "center", fontWeight: 600, fontSize: 15, color: "var(--ink)" }}>{value}</span>
      <StepBtn label="+" onClick={() => onChange(Math.min(max, value + 1))} />
    </span>
  );
}

function StepBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ width: 24, height: 24, borderRadius: 7, border: "none", background: "var(--paper-2)", color: "var(--ink-2)", cursor: "pointer", fontSize: 15, lineHeight: 1 }}
    >
      {label}
    </button>
  );
}

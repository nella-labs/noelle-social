"use client";

import { useState, useTransition } from "react";
import { Zap } from "lucide-react";
import { AppLink as Link } from "@/components/nav/AppLink";
import type { PostDraftRow } from "@/lib/posts-queries";
import { triggerIdeation, schedulePostIdea } from "@/app/app/[orgSlug]/approvals/posts/actions";
import { CONFIG_BY_PLATFORM } from "@/lib/agent-content-config";
import { LANE_BY_ID } from "./content-lanes";
import { addDays } from "./schedule-dates";
import styles from "./overview.module.css";

export function ContentWeekPlanner({ orgSlug, drafts, today, platform = null }: {
  orgSlug: string;
  drafts: PostDraftRow[];
  today: string;
  platform?: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [dragOver, setDragOver] = useState<string | null>(null);
  const base = `/app/${orgSlug}/content`;
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(today, index);
    const anchor = new Date(`${date}T00:00:00Z`);
    return { date, today: index === 0, dow: anchor.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }), num: anchor.getUTCDate() };
  });
  const draftHref = (id: string) => `${base}?board=drafts${platform ? `&platform=${platform}` : ""}&focus=${id}`;
  const lane = platform === "x" || platform === "linkedin" || platform === "reddit" ? platform : null;
  const canIdeate = !platform || (lane !== null && CONFIG_BY_PLATFORM[lane].capabilities.canIdeate);

  function batch() {
    if (!canIdeate) return;
    startTransition(async () => { await triggerIdeation({ orgSlug, mode: "batch", platform: lane === "x" || lane === "linkedin" ? lane : undefined }); });
  }

  return (
    <section className={styles.planner} aria-labelledby="content-week-title" style={{ opacity: pending ? .7 : 1 }}>
      <div className={styles.panelHead}>
        <div><h3 id="content-week-title">The week ahead</h3><p>Your planned posts, day by day. Drag a draft to move it.</p></div>
        {canIdeate && <button className="btn btn-sm" onClick={batch} disabled={pending}><Zap size={13} aria-hidden />{pending ? "Queuing…" : "Generate weekly batch"}</button>}
      </div>
      <div className={styles.plannerGrid}>
        {days.map((day) => {
          const items = drafts.filter((draft) => draft.suggested_day === day.date);
          return (
            <div key={day.date} className={`${styles.plannerDay}${day.today ? ` ${styles.plannerToday}` : ""}${dragOver === day.date ? ` ${styles.plannerDrop}` : ""}`}
              onDragOver={(event) => { event.preventDefault(); setDragOver(day.date); }}
              onDragLeave={() => setDragOver((date) => date === day.date ? null : date)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(null);
                const raw = event.dataTransfer.getData("text/plain");
                if (!raw) return;
                try {
                  const { ideaId } = JSON.parse(raw) as { ideaId?: string };
                  if (ideaId) startTransition(async () => { await schedulePostIdea({ orgSlug, ideaId, day: day.date }); });
                } catch { /* Invalid drag payloads have no scheduling effect. */ }
              }}>
              <div className={styles.dayHead}><span>{day.today ? "Today" : day.dow}</span><strong>{day.num}</strong></div>
              <div className={styles.dayCards}>
                {items.map((draft) => {
                  const lane = LANE_BY_ID[draft.platform] ?? LANE_BY_ID.x;
                  return (
                    <Link key={draft.id} href={draftHref(draft.id)} title={draft.draft_hook || draft.hook} className={styles.dayCard} draggable
                      onDragStart={(event) => { event.dataTransfer.setData("text/plain", JSON.stringify({ ideaId: draft.idea_id, draftId: draft.id })); event.dataTransfer.effectAllowed = "move"; }}>
                      <span style={{ color: lane.color }}>{lane.label}</span><p>{draft.draft_hook || draft.hook}</p>
                    </Link>
                  );
                })}
                {items.length === 0 && <div className={styles.emptyDay}>No posts planned</div>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

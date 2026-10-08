"use client";

import { useState, useTransition } from "react";
import { createComposeJobAction } from "@/app/app/[orgSlug]/content/schedule-actions";

/** Remix a trending post into one on-brand draft scheduled for today (reuses the Compose action). */
export function TrendingRemixButton({
  orgSlug,
  instanceId,
  platform,
  today,
  topic,
  color,
}: {
  orgSlug: string;
  instanceId: string;
  platform: string;
  today: string;
  topic: string;
  color: string;
}) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);

  function remix() {
    if (done) return;
    start(async () => {
      try {
        await createComposeJobAction(orgSlug, {
          instanceId,
          platform,
          perDay: 1,
          days: 1,
          startDate: today,
          topic,
          autoPublish: false,
        });
        setDone(true);
      } catch {
        /* surfaced by the revalidate / calendar */
      }
    });
  }

  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={remix}
      disabled={pending || done}
      style={{ boxShadow: `0 0 0 1px ${color}`, opacity: pending ? 0.6 : 1 }}
    >
      {done ? "✓ Remixed" : pending ? "…" : "✦ Remix"}
    </button>
  );
}

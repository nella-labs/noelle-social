"use client";

import { useTransition } from "react";
import { AppLink as Link } from "@/components/nav/AppLink";
import { setLaneEnabled } from "@/app/app/[orgSlug]/agents/[instanceId]/actions";

// The multi-lane control + Intelligence box for Lyra's agent page. Three
// independently-triggerable lanes (Replies / DMs / Posts) each with an enable
// toggle and a link to its board; above them the always-on Intelligence box
// (watchlist + profiler + Engagement Analyst) that feeds every lane.
export function LyraLanesCard({
  orgSlug,
  instanceId,
  approvalsHref,
  repliesOn,
  dmsOn,
  introDmsOn,
  postsOn,
  watchlistCount,
  playbookCount,
  lastAnalyzedAt,
}: {
  orgSlug: string;
  instanceId: string;
  approvalsHref: string;
  repliesOn: boolean;
  dmsOn: boolean;
  introDmsOn: boolean;
  postsOn: boolean;
  watchlistCount: number;
  playbookCount: number;
  lastAnalyzedAt: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const postsHref = `/app/${orgSlug}/content?platform=linkedin`;

  function toggle(lane: "replies" | "dms" | "posts", enabled: boolean, introDmsEnabled?: boolean) {
    startTransition(() => {
      setLaneEnabled({ orgSlug, instanceId, lane, enabled, introDmsEnabled }).then(() => {});
    });
  }

  const lanes: { lane: "replies" | "dms" | "posts"; label: string; href: string; on: boolean }[] = [
    { lane: "replies", label: "Replies", href: approvalsHref, on: repliesOn },
    { lane: "dms", label: "DMs", href: approvalsHref, on: dmsOn },
    { lane: "posts", label: "Posts", href: postsHref, on: postsOn },
  ];

  return (
    <section className="card lanes-card">
      <div className="card-h">
        <h3>Lanes</h3>
      </div>

      {/* Intelligence box — always-on, feeds every lane. */}
      <div className="intel-box">
        <span className="eyebrow">Intelligence · always on</span>
        <div className="intel-row mono">
          <span>{watchlistCount} watched</span>
          <span>·</span>
          <span>{playbookCount} playbooks</span>
        </div>
        <div className="intel-sub mono">
          Engagement Analyst {lastAnalyzedAt ? `· last run ${lastAnalyzedAt.slice(0, 10)}` : "· no runs yet"}
        </div>
      </div>

      <ul className="lane-list">
        {lanes.map((l) => (
          <li key={l.lane} className="lane-row">
            <button
              type="button"
              className={`lane-switch${l.on ? " lane-switch--on" : ""}`}
              aria-pressed={l.on}
              disabled={pending}
              onClick={() => toggle(l.lane, !l.on)}
              title={l.on ? "On — click to pause this lane" : "Off — click to enable"}
            >
              <span className="lane-switch__dot" />
            </button>
            <Link href={l.href} className="lane-name">
              {l.label}
            </Link>
            {l.lane === "dms" && l.on && (
              <label className="lane-introdm" title="Proactive intro/outreach DMs to watchlist people">
                <input
                  type="checkbox"
                  checked={introDmsOn}
                  disabled={pending}
                  onChange={(e) => toggle("dms", true, e.target.checked)}
                />
                <span>intro DMs</span>
              </label>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

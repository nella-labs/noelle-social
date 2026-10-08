import { getOrgBySlug } from "@/lib/queries";
import {
  getInstanceIdForRole,
  listComposeJobsForInstance,
  listBatchSlotDays,
} from "@/lib/schedule-queries";
import { listPostIdeasForOrg } from "@/lib/posts-queries";
import {
  CONFIG_BY_PLATFORM,
  platformToRole,
  type WorkspaceLaneView,
} from "@/lib/agent-content-config";
import { ChannelSetupNotice } from "./ChannelSetupNotice";
import { ComposeForm } from "./ComposeForm";
import { ComposeReviewBoard } from "./ComposeReviewBoard";
import { dayOfMonth, monthLabel } from "./schedule-dates";

/**
 * The Compose section. For X + LinkedIn it's REVIEW-FIRST: plan a batch, the
 * agent proposes ideas, and you approve (→ drafts) or kill (→ a replacement
 * appears) each below. For Reddit/Video it stays the direct batch-schedule with
 * the live day-card progress strip.
 */
export async function ComposePanel({ lane, orgSlug }: { lane: WorkspaceLaneView; orgSlug: string }) {
  const org = await getOrgBySlug(orgSlug);
  if (!org) return null;
  if (lane.platform === "all") return null;

  const role = platformToRole(lane.platform);
  const cfg = CONFIG_BY_PLATFORM[lane.platform];
  const instanceId = role ? await getInstanceIdForRole(org.id, role) : null;
  const agent = lane.identity.agent;

  if (!instanceId) {
    return <ChannelSetupNotice orgSlug={orgSlug} role={cfg.role}>
      Set up this channel to plan a batch of posts.
    </ChannelSetupNotice>;
  }

  const today = new Date().toISOString().slice(0, 10);
  // X + LinkedIn run post-ideation → review-first. Reddit (replies-only) + Video
  // (own idea system) keep the direct batch-schedule.
  const reviewMode = lane.platform === "x" || lane.platform === "linkedin";

  const form = (
    <ComposeForm
      orgSlug={orgSlug}
      instanceId={instanceId}
      platform={lane.platform}
      canAutoPost={cfg.capabilities.canAutoPost}
      laneColor={lane.identity.color}
      today={today}
    />
  );

  if (reviewMode) {
    const proposed = await listPostIdeasForOrg(org.id, ["proposed"], lane.platform);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {form}
        <ComposeReviewBoard
          orgSlug={orgSlug}
          ideas={proposed}
          platform={lane.platform}
          laneColor={lane.identity.color}
          agent={agent}
        />
      </div>
    );
  }

  const jobs = await listComposeJobsForInstance(org.id, instanceId);
  const latest = jobs[0];
  const days = latest ? await listBatchSlotDays(org.id, latest.id) : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {form}
      {latest && days.length > 0 ? (
        <BatchProgress
          drafted={days.reduce((n, d) => n + d.drafted, 0)}
          total={latest.items_total}
          prompt={latest.prompt}
          laneColor={lane.identity.color}
          days={days}
        />
      ) : null}
    </div>
  );
}

function BatchProgress({
  drafted,
  total,
  prompt,
  laneColor,
  days,
}: {
  drafted: number;
  total: number;
  prompt: string | null;
  laneColor: string;
  days: { day: string; total: number; drafted: number }[];
}) {
  const pct = total > 0 ? Math.round((drafted / total) * 100) : 0;
  const activeIdx = days.findIndex((d) => d.drafted < d.total);
  return (
    <div className="card clay-flat" style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: drafted < total ? laneColor : "var(--ok)" }} />
          <span className="serif" style={{ fontSize: 17 }}>
            {drafted < total
              ? `Drafting day ${Math.max(0, activeIdx) + 1} of ${days.length}…`
              : "Batch ready"}
          </span>
        </div>
        <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--ink-muted)" }}>
          {drafted} <span style={{ color: "var(--ink-soft)" }}>/ {total}</span>
        </span>
      </div>

      <div style={{ height: 5, borderRadius: 999, background: "var(--paper-deep)", overflow: "hidden", marginBottom: 16 }}>
        <div style={{ height: "100%", width: `${pct}%`, background: laneColor, borderRadius: 999, transition: "width .4s" }} />
      </div>

      <div className="scroll-x-phone" style={{ display: "grid", gridAutoFlow: "column", gridAutoColumns: "minmax(96px, 1fr)", gap: 8 }}>
        {days.map((d, i) => {
          const done = d.drafted >= d.total;
          const active = i === activeIdx;
          return (
            <div
              key={d.day}
              style={{
                padding: "9px 10px 10px",
                borderRadius: 10,
                background: active ? `color-mix(in oklch, ${laneColor} 8%, var(--paper-2))` : "var(--paper-2)",
                boxShadow: active ? `0 0 0 1.5px ${laneColor}` : "0 0 0 0.5px var(--rule)",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: done ? "var(--ink-2)" : "var(--ink)" }}>Day {i + 1}</span>
                {done ? <span style={{ color: "var(--ok)", fontSize: 12 }}>✓</span> : null}
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-muted)", marginTop: 2 }}>
                {monthLabel(d.day).split(" ")[0]?.slice(0, 3)} {dayOfMonth(d.day)}
              </div>
              <div style={{ display: "flex", gap: 3, marginTop: 7, flexWrap: "wrap" }}>
                {Array.from({ length: d.total }, (_, k) => (
                  <span
                    key={k}
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      background: k < d.drafted ? laneColor : "var(--rule)",
                    }}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {prompt ? (
        <div style={{ marginTop: 12, fontSize: 12, color: "var(--ink-muted)", fontStyle: "italic" }}>“{prompt}”</div>
      ) : null}
    </div>
  );
}

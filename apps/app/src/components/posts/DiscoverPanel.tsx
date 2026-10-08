import { AppLink as Link } from "@/components/nav/AppLink";
import {
  getVideoHarvestStatus,
  getVideoFeederConfig,
  type VideoClipRow,
} from "@/lib/video-queries";
import { maintenanceNote } from "@/lib/agent-ui-config";
import { requestVideoHarvest } from "@/app/app/[orgSlug]/agents/[instanceId]/video-watchlist-actions";
import { Avatar } from "@/components/constellation/Avatar";
import { VideoDiscoverGrid } from "./VideoDiscoverGrid";
import { HarvestConsole } from "./HarvestConsole";

const NOVA_ACCENT = "oklch(0.58 0.13 305)";

/**
 * Discover — Nova's harvested reels (the real video_clips corpus), the video
 * lane's "Media" board, rendered through the SAME Content workspace chrome as
 * every other lane. Read-only here: the creator/niche watchlist + filter knobs
 * live on Nova's watchlist page (one clear button away); this board shows the
 * loot + lets you kick off a fresh harvest. Only Nova has a harvest, so the
 * other lanes show their uploaded Media library instead (MediaPanel).
 */
export async function DiscoverPanel({
  orgSlug,
  instanceId,
  clips,
}: {
  orgSlug: string;
  instanceId: string;
  clips: VideoClipRow[];
}) {
  const [status, cfg] = await Promise.all([
    getVideoHarvestStatus(instanceId),
    getVideoFeederConfig(instanceId),
  ]);
  const watchlistHref = `/app/${orgSlug}/agents/${instanceId}/watchlist`;
  const parked = maintenanceNote("video_intern");
  const state = status?.state ?? "idle";
  const stateTone =
    state === "running" || state === "requested"
      ? "var(--warn)"
      : state === "stalled" || state === "errored"
        ? "var(--danger)"
        : "var(--ok)";
  const stateLabel =
    state === "running" ? "harvesting…"
    : state === "requested" ? "harvest queued"
    : state === "stalled" ? "harvest stalled"
    : state === "errored" ? "last harvest errored"
    : "idle";
  const lastRun = status?.lastRunAt
    ? new Date(status.lastRunAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    : null;

  return (
    <div>
      {/* Harvest header — real status + the clear route to the watchlist. */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Avatar role="video-intern" size={30} accent={NOVA_ACCENT} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 500 }}>Nova · harvest</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-muted)" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: stateTone }} />
              {parked ? "Manual tools" : stateLabel}
              {lastRun ? <span style={{ color: "var(--ink-soft)" }}>· last run {lastRun}</span> : null}
              <span style={{ color: "var(--ink-soft)" }}>· {clips.length} clip{clips.length === 1 ? "" : "s"}</span>
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
            {!parked && (            <form
              action={async () => {
                "use server";
                await requestVideoHarvest({ orgSlug, instanceId });
              }}
            >
              <button className="btn btn-sm" type="submit" disabled={state === "running" || state === "requested"}>
                ⟳ Run harvest
              </button>
            </form>)}
            <Link className="btn btn-sm btn-primary" href={watchlistHref}>
              Manage watchlist →
            </Link>
          </div>
        </div>

        {/* Real filter knobs (read-only summary) — edit them on the watchlist. */}
        <div style={{ display: "flex", gap: 6, marginTop: 14, flexWrap: "wrap" }}>
          <ConfigChip label={`top ${cfg.topByViews} by views`} />
          <ConfigChip label={`outperformer ≥ ${cfg.outperformers.ratio}×`} />
          <ConfigChip label={`last ${cfg.recencyWindowDays}d`} />
          <ConfigChip label={`deep ≥ P${cfg.deepTierPercentile}`} />
          <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-soft)", alignSelf: "center" }}>
            Draft-only · Nova never posts — you record + post by hand.
          </span>
        </div>
      </div>

      {parked && <p className="muted">{parked}</p>}

      {/* Live run console — outcomes, drop reasons, progress, Stop. */}
      {status ? <HarvestConsole orgSlug={orgSlug} instanceId={instanceId} initial={status} /> : null}

      {/* Clip grid */}
      {clips.length === 0 ? (
        <div className="card clay-flat ideas-empty">
          <h3 className="serif">No saved clips yet</h3>
          <p>
            Existing saved clips appear here. You can keep planning video ideas and scripts from Content.
          </p>
          <Link className="btn btn-sm btn-primary" href={watchlistHref}>
            Set up creators &amp; niches →
          </Link>
        </div>
      ) : (
        <VideoDiscoverGrid clips={clips} orgSlug={orgSlug} instanceId={instanceId} />
      )}
    </div>
  );
}

function ConfigChip({ label }: { label: string }) {
  return (
    <span
      style={{
        fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.04em",
        padding: "3px 9px", borderRadius: 999, background: "var(--paper-2)",
        boxShadow: "0 0 0 0.5px var(--rule)", color: "var(--ink-muted)",
      }}
    >
      {label}
    </span>
  );
}

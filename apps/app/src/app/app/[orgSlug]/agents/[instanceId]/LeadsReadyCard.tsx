import { AppLink as Link } from "@/components/nav/AppLink";
import type { PipelineSnapshot } from "@/lib/queries";

/**
 * Left-rail "Leads ready" card — sits directly below the Watchlist card.
 *
 * Answers the one question the operator actually has on this page: "how many
 * leads are waiting for me to reply, and where do I click to do it?" It shows
 * the human-facing DISTINCT-lead count, not the raw approval-row count (a lead
 * carries a reply + DM draft, so rows ≈ 4× and would read as a scary,
 * meaningless number).
 *
 * Scoped to the most recent goal-run (`snapshot.leadsReadyLastRun`, tagged
 * "last run") when the instance has run a goal, so a small experiment isn't
 * buried under leads from earlier runs. Falls back to the cumulative pending
 * count (`snapshot.leadsReady`) only when there's never been a run.
 *
 * Server component on purpose: it renders purely from the snapshot the page
 * already fetched, so it carries zero hydration risk (no render-time Date.now /
 * toLocaleString) and updates for free whenever the PipelinePanel's auto-refresh
 * re-renders the page — the bar width then CSS-transitions, giving the live
 * "loading bar" feel without any client clock.
 */
export function LeadsReadyCard({
  orgSlug,
  snapshot,
  nextApprovalHref,
  approvalsListHref,
}: {
  orgSlug: string;
  snapshot: PipelineSnapshot;
  /**
   * Deep link to the single highest-priority pending lead's review page — the
   * top row of the approvals queue. The "Review & reply" button opens THIS lead
   * so the operator lands on the one to action next, instead of the whole-queue
   * list. Null when nothing is pending (or the id can't be resolved); the button
   * then falls back to the queue list URL.
   */
  nextApprovalHref?: string | null;
  /**
   * Where the "Review & reply" button falls back to when there's no specific
   * lead to deep-link. Defaults to the org-wide approvals queue (the X intern's
   * default stream); the LinkedIn intern passes her own stream
   * (`?stream=linkedin-intern`) so the fallback lands on Lyra's draft-only inbox.
   */
  approvalsListHref?: string;
}) {
  const { leadsReady, leadsReadyLastRun, goal } = snapshot;
  const goalActive = goal.target != null;
  const hasLastRun = leadsReadyLastRun != null;
  // Scope the headline to the most recent run when there's been one, so a small
  // experiment isn't buried under leads piled up from earlier runs. Fall back to
  // the cumulative pending count only when the instance has never run a goal.
  const count = hasLastRun ? leadsReadyLastRun : leadsReady;
  const target = goal.target ?? 0;
  // During a goal-run, fill toward the target; otherwise the bar is a calm full
  // bar when there's anything to review, empty when the queue is clear.
  const pct = goalActive
    ? Math.min(100, target > 0 ? Math.round((goal.produced / target) * 100) : 0)
    : count > 0
      ? 100
      : 0;
  const goalReached = goalActive && goal.produced >= target;
  const listHref = approvalsListHref ?? `/app/${orgSlug}/approvals`;
  // Open the specific next lead when we have one; fall back to the full queue
  // only when there's nothing pending to deep-link to.
  const reviewHref = nextApprovalHref ?? listHref;
  const empty = count === 0 && !goalActive;

  return (
    <section className="card">
      <div className="card-h">
        <h3>Leads ready</h3>
        {goalActive ? (
          <span className="tag tag-ok">
            <span className="dot dot-ok" /> run
          </span>
        ) : hasLastRun ? (
          <span className="tag">last run</span>
        ) : null}
      </div>

      {empty ? (
        <div style={{ fontSize: 12.5, color: "var(--ink-muted)", marginTop: 4 }}>
          No leads waiting yet. Start the pipeline (or a goal-run) and they’ll
          pile up here, ready to reply.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 2 }}>
            <span className="serif" style={{ fontSize: 40, lineHeight: 1 }}>
              {count}
            </span>
            <span style={{ fontSize: 13, color: "var(--ink-muted)" }}>
              {goalActive ? (
                <>
                  / {target} ready{goalReached ? " ✓" : ""}
                </>
              ) : (
                <>ready to reply</>
              )}
            </span>
          </div>

          <div className="bar-track" style={{ height: 8, marginTop: 12 }}>
            <div
              className="bar-fill acc"
              style={{ width: `${pct}%`, transition: "width .5s ease" }}
            />
          </div>

          {goalActive ? (
            <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 8 }}>
              {goalReached
                ? `Goal hit — pausing at ${target}.`
                : `Climbing to ${target}. Auto-pauses when it gets there.`}
            </div>
          ) : null}
        </>
      )}

      <Link
        href={reviewHref}
        className="btn btn-sm btn-primary"
        style={{ width: "100%", marginTop: 14, justifyContent: "center" }}
        aria-disabled={empty}
      >
        Review &amp; reply →
      </Link>
    </section>
  );
}

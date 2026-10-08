import { AppLink } from "@/components/nav/AppLink";
import type { GrowthOverviewData } from "@/lib/growth-overview";
import { WorkspacePanel } from "./WorkspacePanel";
import styles from "./growth.module.css";

export function GrowthPerformance({ performance, orgSlug }: { performance: GrowthOverviewData["performance"]; orgSlug: string }) {
  const measured = performance?.status === "ready" ? performance.value : null;
  return (
    <WorkspacePanel title="What is getting a response" meta="Measured X posts · snapshots from the last 90 days" action={<AppLink href={`/app/${orgSlug}/content?platform=x&board=performance`} className="btn btn-sm btn-ghost">View posts</AppLink>}>
      {!measured || measured.posts.length === 0 ? (
        <p className={styles.empty}>{performance?.status === "unavailable" ? "Post performance is unavailable. Refresh to try again." : "Measured post performance will appear after published posts are tracked."}</p>
      ) : (
        <>
          <div className={styles.performanceSummary}>
            {[
              { label: "Impressions", value: measured.totals.impressions },
              { label: "Likes", value: measured.totals.likes },
              { label: "Reposts", value: measured.totals.reposts },
              { label: "Replies", value: measured.totals.replies },
            ].map((metric) => <div key={metric.label}><strong>{metric.value?.toLocaleString("en-US") ?? "—"}</strong><small>{metric.label}</small></div>)}
          </div>
          <div className={styles.postList}>
            {measured.posts.slice(0, 3).map((post) => (
              <div className={styles.post} key={post.externalId}>
                <div>{post.url ? <a href={post.url} target="_blank" rel="noreferrer">{post.preview || "Published post"}</a> : <span>{post.preview || "Published post"}</span>}<small>{post.likes} likes · {post.reposts} reposts · {post.replies} replies</small></div>
                <strong>{post.engagement}<small>responses</small></strong>
              </div>
            ))}
          </div>
          <p className={styles.note}>Totals cover {measured.totals.posts} measured posts, up to 50. Impressions are available for {measured.totals.postsWithImpressions} posts.</p>
        </>
      )}
    </WorkspacePanel>
  );
}

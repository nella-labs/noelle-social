/**
 * Segment-level loading UI for the whole dashboard.
 *
 * Next renders this the instant a <Link> to any /app/{org}/* route is
 * clicked, while the (dynamic, DB-heavy) destination renders on the server.
 * Without it, a click gave zero feedback — the old page just sat there for a
 * second or two until the server finished, which read as "the button does
 * nothing." The shared layout (NavRail, breadcrumbs) stays mounted; only this
 * page-area skeleton swaps in.
 */
export default function DashboardLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" style={{ opacity: 0.9 }}>
      {/* PageHeader shape */}
      <div className="page-h">
        <div style={{ flex: 1 }}>
          <Bar w={120} h={11} />
          <Bar w={280} h={34} mt={12} />
          <Bar w={460} h={13} mt={12} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Bar w={84} h={30} radius={9} />
          <Bar w={104} h={30} radius={9} />
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 8 }}>
        <CardSkeleton rows={3} />
        <CardSkeleton rows={5} />
      </div>
    </div>
  );
}

function CardSkeleton({ rows }: { rows: number }) {
  return (
    <section className="card">
      <div className="card-h">
        <Bar w={160} h={16} />
        <Bar w={64} h={20} radius={999} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 6 }}>
        {Array.from({ length: rows }).map((_, i) => (
          <Bar key={i} w={`${92 - i * 7}%`} h={13} />
        ))}
      </div>
    </section>
  );
}

function Bar({
  w,
  h,
  mt = 0,
  radius = 6,
}: {
  w: number | string;
  h: number;
  mt?: number;
  radius?: number;
}) {
  return (
    <div
      style={{
        width: typeof w === "number" ? `${w}px` : w,
        height: h,
        marginTop: mt,
        borderRadius: radius,
        background: "var(--paper-2)",
        boxShadow: "0 0 0 0.5px var(--rule-soft)",
        animation: "skeleton-pulse 1.4s ease-in-out infinite",
      }}
    />
  );
}

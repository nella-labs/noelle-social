/**
 * Rendered in place of admin content when the current user isn't on the
 * admin allowlist. We deliberately don't 404 — tenants poking at /admin
 * deserve a clear message, not a confusing not-found.
 */
export function AdminGate() {
  return (
    <div className="placeholder-card" style={{ maxWidth: 460, marginTop: 32 }}>
      <div className="placeholder-stars" />
      <div className="serif" style={{ fontSize: 28, position: "relative" }}>
        Operations is admin-only.
      </div>
      <div style={{ color: "var(--ink-muted)", marginTop: 10, position: "relative", fontSize: 13 }}>
        The internal Operations dashboard is restricted to Noelle staff. If
        you reached this page by accident, head back to your{" "}
        <span style={{ color: "var(--ink-2)" }}>Constellation</span>.
      </div>
    </div>
  );
}

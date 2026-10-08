/**
 * Section wrapper used by admin pages — serif heading + muted sub +
 * optional right-aligned slot. Identical to the design dump's
 * `AdminSection`.
 */
interface AdminSectionProps {
  title: string;
  sub?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}

export function AdminSection({ title, sub, right, children }: AdminSectionProps) {
  return (
    <section style={{ marginBottom: 28 }}>
      <div className="action-bar-phone" style={{ display: "flex", alignItems: "baseline", marginBottom: 12, gap: 14 }}>
        <h3
          className="serif"
          style={{ margin: 0, fontSize: 22, fontWeight: 400, letterSpacing: "-0.01em" }}
        >
          {title}
        </h3>
        {sub ? <div style={{ color: "var(--ink-muted)", fontSize: 12.5 }}>{sub}</div> : null}
        {right ? <div style={{ marginLeft: "auto" }}>{right}</div> : null}
      </div>
      {children}
    </section>
  );
}

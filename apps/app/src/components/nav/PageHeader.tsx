/**
 * PageHeader — eyebrow, italic-accent serif title, sub, right slot.
 *
 * Title may contain <em>…</em> spans (rendered as italic + accent color
 * via the `.page-title em` rule in globals.css).
 */
interface PageHeaderProps {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  right?: React.ReactNode;
}

export function PageHeader({ eyebrow, title, sub, right }: PageHeaderProps) {
  return (
    <div className="page-h">
      <div className="page-h-copy">
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1 className="page-title">{title}</h1>
        {sub ? <div className="page-sub">{sub}</div> : null}
      </div>
      {right ? (
        <div className="page-h-actions">{right}</div>
      ) : null}
    </div>
  );
}

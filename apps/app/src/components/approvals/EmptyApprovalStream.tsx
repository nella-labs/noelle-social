import type { StreamAgentRole } from "@/lib/approval-streams";
import { AppLink as Link } from "@/components/nav/AppLink";
import { StreamAvatar } from "./StreamAvatar";
import styles from "./stream-controls.module.css";

interface Props {
  role: StreamAgentRole;
  title: string;
  description: string;
  note: string;
  backHref: string;
  primary?: { href: string; label: string };
}

export function EmptyApprovalStream({ role, title, description, note, backHref, primary }: Props) {
  return (
    <section className={styles.emptyStream}>
      <StreamAvatar role={role} size={56} />
      <h2>{title}</h2>
      <p>{description}</p>
      <span className={styles.emptyNote}>{note}</span>
      <div className={styles.emptyActions}>
        <Link href={backHref} className="btn btn-ghost">See X conversations</Link>
        {primary ? <Link href={primary.href} className="btn btn-primary">{primary.label}</Link> : null}
      </div>
    </section>
  );
}

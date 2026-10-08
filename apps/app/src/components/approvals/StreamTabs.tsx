import { AppLink as Link } from "@/components/nav/AppLink";
import { StreamAvatar } from "./StreamAvatar";
import type { ApprovalStream } from "@/lib/approval-streams";
import styles from "./stream-controls.module.css";

interface Props {
  streams: ApprovalStream[];
  active: string;
  basePath: string;
}

export function StreamTabs({ streams, active, basePath }: Props) {
  return (
    <nav className={styles.tabs} aria-label="Engagement channels">
      {streams.map((stream) => {
        const on = stream.id === active;
        const href = stream.id === "x-intern" ? basePath : `${basePath}?stream=${stream.id}`;
        return (
          <Link
            key={stream.id}
            href={href}
            scroll={false}
            className={styles.tab}
            data-active={on || undefined}
            data-setup={stream.status !== "live" || undefined}
            aria-current={on ? "page" : undefined}
          >
            <StreamAvatar role={stream.agentRole} size={28} />
            <span className={styles.tabLabel}>
              <span className={styles.network}>{stream.network}</span>
              <span className={styles.surface}>{stream.surface}</span>
            </span>
            <StatusBadge stream={stream} />
          </Link>
        );
      })}
    </nav>
  );
}

function StatusBadge({ stream }: { stream: ApprovalStream }) {
  if (stream.status === "live") {
    return <span className={styles.count}>{stream.count}</span>;
  }
  return <span className={styles.status}>{"Set up"}</span>;
}

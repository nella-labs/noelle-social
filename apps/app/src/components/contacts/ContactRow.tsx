import { ArrowUpRight } from "lucide-react";
import { AppLink as Link } from "@/components/nav/AppLink";
import { timeAgo } from "@/lib/utils";
import type { PersonListItem } from "@/lib/queries";
import styles from "./contacts.module.css";

const PLATFORM_LABEL: Record<string, string> = { x: "X", linkedin: "LinkedIn", reddit: "Reddit" };
const LIVE_PLATFORMS = new Set(["x", "linkedin"]);

export function ContactRow({ person, orgSlug, styleSource = false }: { person: PersonListItem; orgSlug: string; styleSource?: boolean }) {
  const handle = person.xHandle ? `@${person.xHandle}` : person.linkedinHandle;
  const name = person.displayName || handle || "Unnamed contact";
  const initials = name.replace(/^@/, "").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return (
    <li>
      <Link href={`/app/${orgSlug}/contacts/${person.id}`} className={styles.row}>
        <div className={styles.identity}><span className={styles.avatar} aria-hidden>{initials}</span><div><strong>{name}</strong><span>{handle || "No linked handle"}</span><div className={styles.badges}>{person.watchedBy.length > 0 && <span className={styles.watchBadge} title={`Watched by ${person.watchedBy.join(", ")}`}>{person.watchedBy.length === 1 ? person.watchedBy[0] : `${person.watchedBy.length} agents`}</span>}{styleSource && <span className={styles.styleBadge} title="Lyra learns its writing style from this account">Style source</span>}</div></div></div>
        <div className={styles.platforms}>{person.platforms.map((platform) => <span key={platform} className="tag" style={{ opacity: LIVE_PLATFORMS.has(platform) ? 1 : .5 }} title={`${PLATFORM_LABEL[platform] ?? platform} (${LIVE_PLATFORMS.has(platform) ? "live" : "not connected"})`}>{PLATFORM_LABEL[platform] ?? platform}</span>)}</div>
        <div className={styles.activity} data-label="Replies"><strong>{person.repliesSent} sent</strong>{person.pendingReplies > 0 && <span>{person.pendingReplies} pending</span>}</div>
        <span className={styles.lastSeen} data-label="Last interaction">{person.lastInteractionAt ? timeAgo(person.lastInteractionAt) : "—"}</span>
        <ArrowUpRight size={16} className={styles.arrow} aria-hidden />
      </Link>
    </li>
  );
}

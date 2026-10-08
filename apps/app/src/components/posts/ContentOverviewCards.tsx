import { ArrowUpRight, CalendarDays, Lightbulb, PenLine } from "lucide-react";
import { AppLink as Link } from "@/components/nav/AppLink";
import styles from "./overview.module.css";

type ContentMetric = { label: string; value: number; sub: string; href?: string; kind: "ideas" | "drafts" | "scheduled" };
const icons = { ideas: Lightbulb, drafts: PenLine, scheduled: CalendarDays };

export function ContentOverviewCards({ metrics }: { metrics: ContentMetric[] }) {
  return (
    <div className={styles.metrics}>
      {metrics.map((metric, index) => {
        const Icon = icons[metric.kind];
        const content = <>
          <div className={styles.metricTop}><span className={styles.metricIcon}><Icon size={18} aria-hidden /></span><span>{metric.label}</span>{metric.href && <ArrowUpRight size={17} className={styles.metricArrow} aria-hidden />}</div>
          <div className={styles.metricValue}>{metric.value}</div>
          <p className={styles.metricSub}>{metric.sub}</p>
        </>;
        const className = `${styles.metric}${index === 0 ? ` ${styles.featured}` : ""}`;
        return metric.href ? <Link key={metric.kind} className={className} href={metric.href}>{content}</Link> : <div key={metric.kind} className={className}>{content}</div>;
      })}
    </div>
  );
}

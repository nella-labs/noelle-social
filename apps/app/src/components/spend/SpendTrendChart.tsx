import { BarChart3 } from "lucide-react";
import type { SpendDayPoint } from "@/lib/queries";
import styles from "./spend.module.css";

export function SpendTrendChart({ points, max, rangeLabel = "the selected range", apifyAvailable = true }: { points: SpendDayPoint[]; max: number; rangeLabel?: string; apifyAvailable?: boolean }) {
  const width = 100;
  const height = 50;
  const plotHeight = height - 4;
  const slot = width / Math.max(1, points.length);
  const gap = Math.min(slot * .3, 1);
  const barWidth = Math.max(.25, slot - gap);
  const safeMax = Math.max(1, max);
  const hasData = points.some((point) => point.llmCents + point.apifyCents > 0);
  if (!hasData) return <div className={styles.chartEmpty}><BarChart3 size={24} aria-hidden /><strong>{apifyAvailable ? "No spend recorded" : "No model spend recorded"}</strong><p>Bars appear as your agents run during {rangeLabel.toLowerCase()}.{!apifyAvailable && " Apify usage has not been fetched yet."}</p></div>;

  return (
    <div className={styles.chart}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Spend for ${rangeLabel}, with LLM and Apify usage stacked`}>
        {[0, .25, .5, .75, 1].map((ratio) => <line key={ratio} x1={0} x2={width} y1={height - ratio * plotHeight} y2={height - ratio * plotHeight} stroke="var(--rule)" strokeWidth={.12} strokeDasharray=".8 1" />)}
        {points.map((point, index) => {
          const llmHeight = point.llmCents > 0 ? Math.max(point.llmCents / safeMax * plotHeight, .5) : 0;
          const apifyHeight = point.apifyCents > 0 ? Math.max(point.apifyCents / safeMax * plotHeight, .5) : 0;
          const llmY = height - llmHeight;
          const apifyY = llmY - apifyHeight;
          return <g key={point.day}><title>{`${point.day}: ${(point.llmCents / 100).toFixed(2)} LLM · ${apifyAvailable ? (point.apifyCents / 100).toFixed(2) : "Not fetched"} Apify`}</title>{llmHeight > 0 && <rect x={index * slot + gap / 2} y={llmY} width={barWidth} height={llmHeight} rx={.65} fill="var(--accent)" />}{apifyHeight > 0 && <rect x={index * slot + gap / 2} y={apifyY} width={barWidth} height={apifyHeight} rx={.65} fill="var(--ok)" />}</g>;
        })}
      </svg>
      <div className={styles.chartAxis}><span>{points[0]?.day}</span><span>{points.at(-1)?.day}</span></div>
    </div>
  );
}

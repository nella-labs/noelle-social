import { AppLink as Link } from "@/components/nav/AppLink";
import type { StoredPatternAlertsPage } from "@noelle/runtime/pattern-breaker-db";
import { PatternTag } from "./PatternRuleSection";

interface PatternAlertHistoryProps {
  page: StoredPatternAlertsPage | null;
  nextHref: string | null;
}

export function PatternAlertHistory({ page, nextHref }: PatternAlertHistoryProps) {
  return (
    <section className="card">
      <div className="card-h">
        <h3>Pattern alert history{page ? ` · ${page.total}` : ""}</h3>
      </div>
      {page === null ? (
        <p role="status">Alert history is unavailable.</p>
      ) : (
        <>
          <p>Showing {page.alerts.length} alerts on this page.</p>
          {page.alerts.map((alert) => (
            <article
              key={alert.id}
              style={{ padding: "12px 0", borderTop: "1px solid var(--border)" }}
            >
              <strong>{alert.pattern_name}</strong> <PatternTag>{alert.status}</PatternTag>
              <p>{alert.description}</p>
              <p>
                {alert.frequency_count} of {alert.window_size} posts in the observed sample.
              </p>
              {alert.examples.map((example, index) => (
                <blockquote key={index}>{example.snippet}</blockquote>
              ))}
            </article>
          ))}
          {nextHref ? (
            <Link className="btn btn-sm" href={nextHref}>
              Next alerts
            </Link>
          ) : null}
        </>
      )}
    </section>
  );
}

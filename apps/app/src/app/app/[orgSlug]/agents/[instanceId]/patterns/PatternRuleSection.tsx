import { AppLink as Link } from "@/components/nav/AppLink";
import type { PatternRulesPage } from "@noelle/contracts";
import type { PatternRuleRow } from "@/lib/queries";
import { PatternRuleToggle } from "./PatternRuleToggle";

const SEVERITY_STYLE: Record<PatternRuleRow["severity"], { bg: string; fg: string }> = {
  high: {
    bg: "color-mix(in srgb, var(--rust, #b5502e) 16%, transparent)",
    fg: "var(--rust, #b5502e)",
  },
  medium: { bg: "color-mix(in srgb, #c98a2b 18%, transparent)", fg: "#a06a1c" },
  low: { bg: "var(--surface-2, rgba(0,0,0,0.05))", fg: "var(--ink-soft)" },
};

export function PatternTag({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <span
      style={{
        fontSize: 10.5,
        letterSpacing: 0.3,
        textTransform: mono ? undefined : "uppercase",
        color: "var(--ink-soft)",
        border: "1px solid var(--border, rgba(0,0,0,0.1))",
        borderRadius: 5,
        padding: "1px 6px",
        fontFamily: mono ? "var(--mono)" : undefined,
      }}
    >
      {children}
    </span>
  );
}

function RuleItem({
  rule,
  orgSlug,
  instanceId,
}: {
  rule: PatternRuleRow;
  orgSlug: string;
  instanceId: string;
}) {
  const sev = SEVERITY_STYLE[rule.severity];
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        padding: "12px 0",
        borderTop: "1px solid var(--border, rgba(0,0,0,0.07))",
        opacity: rule.active ? 1 : 0.62,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: 4,
          }}
        >
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.3,
              color: sev.fg,
              background: sev.bg,
              borderRadius: 5,
              padding: "1px 7px",
            }}
          >
            {rule.severity}
          </span>
          <PatternTag>{rule.kind}</PatternTag>
          {rule.source !== "auto" ? <PatternTag>{rule.source}</PatternTag> : null}
          <span style={{ fontWeight: 600, fontSize: 13.5 }}>{rule.label}</span>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-muted)", lineHeight: 1.45 }}>
          {rule.instruction}
        </div>
        {!rule.admitted ? (
          <p role="status" style={{ color: "var(--rust)", fontSize: 12 }}>
            This rule cannot be applied. Disable it to allow the complete rule set to load.
          </p>
        ) : null}
        {rule.regex ? (
          <div
            style={{
              fontSize: 11,
              color: "var(--ink-soft)",
              fontFamily: "var(--mono)",
              marginTop: 5,
              wordBreak: "break-all",
            }}
          >
            /{rule.regex}/
          </div>
        ) : null}
      </div>
      <PatternRuleToggle
        orgSlug={orgSlug}
        instanceId={instanceId}
        ruleId={rule.id}
        active={rule.active}
      />
    </div>
  );
}

interface PatternRuleSectionProps {
  title: string;
  count: number | null;
  page: PatternRulesPage | null;
  empty: string;
  orgSlug: string;
  instanceId: string;
  nextHref: string | null;
}

export function PatternRuleSection({
  title,
  count,
  page,
  empty,
  orgSlug,
  instanceId,
  nextHref,
}: PatternRuleSectionProps) {
  return (
    <section className="card">
      <div className="card-h">
        <h3>
          {title}
          {count === null ? "" : ` · ${count}`}
        </h3>
      </div>
      {page === null ? (
        <p role="status">Rules are unavailable. This is not a verified empty rule set.</p>
      ) : page.rules.length === 0 ? (
        <p>{empty}</p>
      ) : (
        <>
          <p>Showing {page.rules.length} rules on this page.</p>
          {page.rules.map((rule) => (
            <RuleItem key={rule.id} rule={rule} orgSlug={orgSlug} instanceId={instanceId} />
          ))}
        </>
      )}
      {nextHref ? (
        <Link className="btn btn-sm" href={nextHref}>
          Next {title.toLowerCase()}
        </Link>
      ) : null}
    </section>
  );
}

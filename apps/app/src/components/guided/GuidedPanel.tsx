import { AppLink as Link } from "@/components/nav/AppLink";
import { DismissGuided } from "@/components/guided/DismissGuided";
import type { GuidedSetup, GuidedStepState, GuidedStepView } from "@/lib/guided/types";

type Props = GuidedSetup & {
  orgSlug: string;
  /** `hero` sits on the dashboard root; `page` is the standalone /onboarding hub. */
  variant?: "hero" | "page";
};

/** Glyph for each state. `todo` and `current` show their position instead. */
function mark(state: GuidedStepState, position: number): string {
  switch (state) {
    case "done":
      return "✓";
    case "waiting":
      return "◷";
    case "blocked":
      return "·";
    default:
      return String(position);
  }
}

const TIER_LABEL: Record<string, string | null> = {
  required: null,
  recommended: "optional",
  advanced: "advanced",
};

function StepRow({ view, position }: { view: GuidedStepView; position: number }) {
  const { step, state, reason, href } = view;
  const tier = TIER_LABEL[step.tier];

  // A blocked step has nowhere useful to send the operator — clicking it would
  // strand them on a page that cannot do anything yet.
  const showCta = state !== "blocked";

  return (
    <li className="guided-step" data-state={state} aria-current={state === "current" ? "step" : undefined}>
      <span className="guided-mark" aria-hidden>
        {mark(state, position)}
      </span>

      <div>
        <div className="guided-step-title">
          <span>{step.title}</span>
          {tier ? (
            <span className="guided-tag" data-tier={step.tier}>
              {tier}
            </span>
          ) : null}
          {state !== "todo" && state !== "current" ? (
            <span className="sr-only">{state}</span>
          ) : null}
        </div>

        {state === "current" || state === "todo" ? (
          <p className="guided-step-blurb">{step.blurb}</p>
        ) : null}
        {reason ? <p className="guided-step-reason">{reason}</p> : null}
      </div>

      {showCta ? (
        <Link href={href} className="guided-cta">
          {state === "done" ? "Revisit" : step.cta}
        </Link>
      ) : null}
    </li>
  );
}

/**
 * The guided setup checklist.
 *
 * Renders inline — it never redirects. The flow this replaces hard-redirected the
 * dashboard root into the vault wizard, which looped forever on Next 15 (see the
 * scar comment in `app/[orgSlug]/layout.tsx`). Rendering in place makes that class
 * of bug structurally impossible.
 */
export function GuidedPanel(props: Props) {
  const { orgSlug, dismissed, variant = "hero" } = props;
  const plan = props.status === "ready" ? props.plan : null;
  const pct = plan ? (plan.requiredTotal === 0 ? 100 : Math.round((plan.requiredDone / plan.requiredTotal) * 100)) : 0;

  return (
    <section className="guided" aria-labelledby="guided-title">
      <span className="guided-stars" aria-hidden />
      <div className="guided-body">
        <div className="guided-head">
          <div className="guided-head-text">
            <div className="guided-eyebrow">
              guided setup{plan ? ` · ${plan.requiredDone} of ${plan.requiredTotal}` : ""}
            </div>
            <h2 id="guided-title" className="guided-title">
              {!plan ? (
                <>Setup is <em>unavailable</em>.</>
              ) : plan.complete ? (
                <>Your setup is <em>complete</em>.</>
              ) : (
                <>Get your first <em>draft</em>.</>
              )}
            </h2>
            <p className="guided-status">{plan?.status ?? "Could not load your setup progress. Reload this page to try again."}</p>
          </div>
        </div>

        {plan ? (
          <>
            <div
              className="guided-bar"
              role="progressbar"
              aria-valuenow={plan.requiredDone}
              aria-valuemin={0}
              aria-valuemax={plan.requiredTotal}
              aria-label="Required setup steps completed"
            >
              <div className="guided-bar-fill" style={{ width: `${pct}%` }} />
            </div>

            <ol className="guided-steps">
              {plan.steps.map((view, i) => (
                <StepRow key={view.step.id} view={view} position={i + 1} />
              ))}
            </ol>
          </>
        ) : null}

        {plan && plan.caveats.length > 0 ? (
          <div className="guided-caveats" role="note">
            {plan.caveats.map((c) => (
              <p key={c} className="guided-caveat">
                {c}
              </p>
            ))}
          </div>
        ) : null}

        <div className="guided-foot">
          <span>
            Review drafts and check each agent&rsquo;s send settings.
          </span>
          {variant === "hero" ? (
            <DismissGuided orgSlug={orgSlug} dismissed={dismissed} label="Hide this" />
          ) : (
            <DismissGuided
              orgSlug={orgSlug}
              dismissed={dismissed}
              label={dismissed ? "Show on dashboard" : "Hide on dashboard"}
            />
          )}
        </div>
      </div>
    </section>
  );
}

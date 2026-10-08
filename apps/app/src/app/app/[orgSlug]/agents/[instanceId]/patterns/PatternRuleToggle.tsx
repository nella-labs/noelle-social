"use client";

import { useState, useTransition } from "react";
import { setPatternRuleActive } from "./actions";

/**
 * Per-rule enable/disable switch for the Pattern Breaker panel. A disabled rule
 * is dropped from the drafter prompt on the next tick (the drafter loads only
 * `active` rules); re-enabling adds it back. Uses the busy + hard-reload pattern
 * (NOT router.refresh()) to dodge the React-19 fast-action reconciler race,
 * matching the rest of the dashboard's manual actions.
 */
export function PatternRuleToggle({
  orgSlug,
  instanceId,
  ruleId,
  active,
}: {
  orgSlug: string;
  instanceId: string;
  ruleId: string;
  active: boolean;
}) {
  const [pending, startT] = useTransition();
  const [busy, setBusy] = useState(false);

  function toggle() {
    setBusy(true);
    startT(async () => {
      try {
        const res = await setPatternRuleActive({
          orgSlug,
          instanceId,
          ruleId,
          active: !active,
        });
        if (res.ok) {
          window.location.reload();
          return;
        }
        if (res.error === "label_conflict") {
          alert(
            "Another active rule already uses this label. Turn that one off first, then re-enable this one.",
          );
        }
      } catch (err) {
        console.error("[patterns] toggle threw:", err);
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <button
      type="button"
      className={`btn btn-xs ${active ? "btn-primary" : ""}`}
      onClick={toggle}
      disabled={pending || busy}
      aria-pressed={active}
      title={
        active
          ? "Enabled — included when the complete valid rule set loads. Click to turn this rule off."
          : "Off — not applied. Click to enable it again."
      }
    >
      {pending || busy ? "…" : active ? "On" : "Off"}
    </button>
  );
}

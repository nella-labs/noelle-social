"use client";

import * as React from "react";
import { AppLink as Link } from "@/components/nav/AppLink";
import { OBJECTIVE_MAX } from "@noelle/contracts";
import { updateObjective } from "@/lib/agent-targeting";

interface ObjectiveCardProps {
  orgSlug: string;
  /** Real instance UUID. Absent on roster placeholders → read-only. */
  instanceId?: string;
  /** Resolved mission (operator objective, else manifest default). */
  mission: string;
  /** True when the displayed mission is operator-set (vs. the built-in default). */
  isCustom: boolean;
  /** Current handle and keyword summary for channels that expose it. */
  targeting?: { handles: string[]; keywords: string[] };
  /** Link to this channel's targeting editor. */
  targetingHref?: string;
  /** Agent display name, for copy ("what Vega hunts for"). */
  agentName: string;
}

const SUMMARY_LIMIT = 6;

/**
 * Objective card — the channel's mission and what it's actively hunting
 * for, shown at the top of the detail page so the operator always sees what the
 * agent is *for*. Inline-editable when there's a real instance; edits go through
 * the updateObjective server action (org-scoped). Empty save resets to the
 * manifest default.
 */
export function ObjectiveCard({
  orgSlug,
  instanceId,
  mission,
  isCustom,
  targeting,
  targetingHref,
  agentName,
}: ObjectiveCardProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const editable = !!instanceId;

  const startEdit = () => {
    setDraft(isCustom ? mission : "");
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    if (!instanceId) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateObjective({ orgSlug, instanceId, objective: draft });
      if (!result.ok) {
        setError(
          result.error === "invalid"
            ? `Keep it under ${OBJECTIVE_MAX} characters.`
            : result.error === "forbidden"
              ? "You don't have permission to edit this agent."
              : "Couldn't save. Try again in a moment.",
        );
        return;
      }
      // Revalidation supplies the resolved mission, including its default.
      setEditing(false);
    } catch (err) {
      console.error("[objective-card] save failed:", err);
      setError("Couldn't save. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card">
      <div className="card-h">
        <h3>Objective</h3>
        {editable && !editing ? (
          <button type="button" className="btn btn-sm" onClick={startEdit}>
            Edit
          </button>
        ) : null}
      </div>

      {editing ? (
        <div style={{ marginTop: 4 }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={OBJECTIVE_MAX}
            autoFocus
            placeholder={`What should ${agentName} focus on? e.g. "find founders frustrated with social media and offer Noelle's angle"`}
            style={{
              width: "100%",
              border: 0,
              background: "var(--paper-2)",
              borderRadius: 8,
              padding: "10px 12px",
              outline: "none",
              resize: "vertical",
              fontFamily: "var(--body)",
              fontSize: 13.5,
              lineHeight: 1.5,
              color: "var(--ink)",
              boxShadow: "0 0 0 0.5px var(--rule)",
            }}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 8,
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              className="btn btn-sm btn-accent"
              onClick={save}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              disabled={saving}
            >
              Cancel
            </button>
            {isCustom ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setDraft("")}
                disabled={saving}
                title="Clear to fall back to the built-in default"
              >
                Reset to default
              </button>
            ) : null}
          </div>
          {error ? (
            <div
              style={{
                marginTop: 6,
                fontSize: 11.5,
                fontFamily: "var(--mono)",
                color: "var(--warn)",
              }}
            >
              {error}
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <p
            className="serif"
            style={{ fontSize: 17, lineHeight: 1.4, margin: "6px 0 0" }}
          >
            {mission}
          </p>
          <div
            style={{
              marginTop: 6,
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--ink-soft)",
            }}
          >
            {isCustom ? "set by you" : "default brief · edit to make it yours"}
          </div>
        </>
      )}

      {targeting ? (
        <>
          <hr className="rule-soft" style={{ margin: "16px 0 12px" }} />
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 8,

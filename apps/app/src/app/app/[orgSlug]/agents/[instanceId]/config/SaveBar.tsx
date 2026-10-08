"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

/**
 * Sticky save bar that only appears when the form is dirty.
 *
 * Dirty detection: on mount we serialise the parent form's FormData into a
 * canonical string. On every `input`/`change` we re-serialise and compare.
 * Reset events compare the restored values to the original baseline. Stays in the DOM (so the spacer doesn't
 * jump when the user toggles a field) but goes visually inert + transparent
 * when clean.
 *
 * Saving state: <SaveButton> reads useFormStatus().pending so the button
 * label + spinner reflect the in-flight server action rather than freezing
 * the moment the user clicks. Previously the action redirected fast enough
 * that the click felt like a no-op.
 */
export function SaveBar({
  helpClean,
  helpDirty,
  canEdit,
}: {
  helpClean: string;
  helpDirty: string;
  canEdit: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [dirty, setDirty] = useState(false);
  const initialRef = useRef<string>("");

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const form = root.closest("form");
    if (!form) return;

    const snapshot = (): string => {
      const fd = new FormData(form);
      const entries: string[] = [];
      fd.forEach((value, key) => {
        entries.push(`${key}=${typeof value === "string" ? value : "[file]"}`);
      });
      entries.sort();
      return entries.join("&");
    };

    initialRef.current = snapshot();

    const recheck = () => {
      setDirty(snapshot() !== initialRef.current);
    };
    const onReset = () => {
      // The form's reset hasn't run yet when the event fires; defer one tick.
      setTimeout(recheck, 0);
    };

    form.addEventListener("input", recheck);
    form.addEventListener("change", recheck);
    form.addEventListener("reset", onReset);
    return () => {
      form.removeEventListener("input", recheck);
      form.removeEventListener("change", recheck);
      form.removeEventListener("reset", onReset);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      aria-hidden={!dirty}
      className="savebar"
      style={{
        position: "sticky",
        bottom: 16,
        marginTop: 8,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 18px",
        background: "var(--paper)",
        color: "var(--ink-muted)",
        borderRadius: 12,
        boxShadow: dirty
          ? "0 0 0 0.5px var(--accent), 0 8px 24px rgba(0,0,0,0.10)"
          : "0 0 0 0.5px var(--rule)",
        zIndex: 5,
        opacity: dirty ? 1 : 0,
        pointerEvents: dirty ? "auto" : "none",
        transform: dirty ? "translateY(0)" : "translateY(8px)",
        transition: "opacity 180ms ease, transform 180ms ease, box-shadow 180ms ease",
      }}
    >
      <span style={{ fontSize: 13, minWidth: 0, flex: "1 1 auto" }}>
        {dirty ? helpDirty : helpClean}
      </span>
      <div className="savebar-actions" style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button
          type="reset"
          className="btn btn-sm"
          disabled={!canEdit || !dirty}
          style={{ whiteSpace: "nowrap" }}
        >
          Revert
        </button>
        <SaveButton canEdit={canEdit} dirty={dirty} />
      </div>
    </div>
  );
}

function SaveButton({ canEdit, dirty }: { canEdit: boolean; dirty: boolean }) {
  const { pending } = useFormStatus();
  const disabled = !canEdit || !dirty || pending;
  return (
    <button
      type="submit"
      className="btn btn-sm btn-accent"
      disabled={disabled}
      aria-busy={pending || undefined}
      style={{
        whiteSpace: "nowrap",
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        minWidth: 116,
        justifyContent: "center",
      }}
    >
      {pending ? (
        <>
          <Spinner />
          <span>Saving…</span>
        </>
      ) : (
        <span>Save changes</span>
      )}
    </button>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 12,
        height: 12,
        borderRadius: 999,
        border: "1.5px solid currentColor",
        borderTopColor: "transparent",
        animation: "noelle-savebar-spin 700ms linear infinite",
      }}
    >
      <style>{`@keyframes noelle-savebar-spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}

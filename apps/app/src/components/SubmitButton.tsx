"use client";

import { useFormStatus } from "react-dom";

/**
 * Submit button that reflects its parent <form>'s pending state, for forms
 * wired to a Server Action. Without this, a raw `<button type="submit">` gives
 * no feedback while the action + revalidation round-trips to Cloud SQL — the
 * click reads as "nothing happened." Must be rendered INSIDE the <form>.
 */
export function SubmitButton({
  children,
  className,
  title,
  pendingLabel = "…",
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
  pendingLabel?: React.ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      title={title}
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}

"use client";

import { AppLink as Link } from "@/components/nav/AppLink";
import { useShowDms } from "@/lib/hooks/useShowDms";

export function DmVisibilityControl({
  showDms,
  setShowDms,
}: {
  showDms: boolean;
  setShowDms: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => setShowDms(!showDms)}
      className={showDms ? "btn btn-sm btn-accent" : "btn btn-sm btn-ghost"}
      style={{ textDecoration: "none" }}
      aria-pressed={showDms}
      title={showDms ? "Hide every DM from Review and Speedrun" : "Show DMs in Review and Speedrun"}
    >
      {showDms ? "Hide DMs" : "Show DMs"}
    </button>
  );
}

/** Agent-page link that opens the approval stream with its shared DM view on. */
export function ReviewFriendlyDmsLink({ href }: { href: string }) {
  const [, setShowDms] = useShowDms();
  return (
    <Link
      href={href}
      onClick={() => setShowDms(true)}
      className="btn btn-xs btn-ghost"
      style={{ marginTop: 8 }}
    >
      Review Friendly DMs →
    </Link>
  );
}

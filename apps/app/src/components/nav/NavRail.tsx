"use client";

import { AppLink as Link } from "@/components/nav/AppLink";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowUpRight, ChartNoAxesCombined, Inbox, LogOut, PenLine, Settings, Users, type LucideIcon } from "lucide-react";
import { Avatar } from "@/components/constellation/Avatar";
import { NoelleBrand } from "@/components/NoelleBrand";

export interface NavRailUser {
  name: string;
  handle: string;
  monogram?: string;
}

export interface NavRailOrg {
  name: string;
}

interface NavRailProps {
  orgSlug: string;
  org: NavRailOrg;
  user: NavRailUser;
  pendingApprovals?: number;
  logoutAction: () => void;
  /**
   * "rail" (default) = the desktop workspace navigation.
   * "drawer" = the same content rendered inside the mobile slide-out panel
   * (<MobileNav>), which neutralizes the fixed-sidebar positioning via the
   * `.nav-drawer-panel .sidebar` override in globals.css.
   */
  variant?: "rail" | "drawer";
}

/**
 * Shared desktop and mobile workspace navigation.
 *
 * Active state is derived from `usePathname()`, so this is a client component.
 */
export function NavRail({
  orgSlug,
  org,
  user,
  pendingApprovals = 0,
  logoutAction,
  variant = "rail",
}: NavRailProps) {
  const pathname = usePathname() ?? "";
  const base = `/app/${orgSlug}`;
  const is = (suffix: string) => {
    const target = suffix === "" ? base : `${base}${suffix}`;
    if (suffix === "") return pathname === base;
    if (suffix === "/settings") return ["/settings", "/agents", "/hire", "/connections", "/vault", "/spend", "/system"].some((path) => pathname === base + path || pathname.startsWith(base + path + "/"));
    return pathname === target || pathname.startsWith(target + "/");
  };

  // Refresh the actionable backlog when the workspace regains focus.
  const [pendingLive, setPendingLive] = useState(pendingApprovals);

  const workspaceItems: Array<{
    suffix: string;
    label: string;
    icon: LucideIcon;
    count?: number;
  }> = [
    { suffix: "", label: "Overview", icon: ChartNoAxesCombined },
    { suffix: "/approvals", label: "Engage", icon: Inbox, count: pendingLive },
    { suffix: "/content", label: "Content", icon: PenLine },
    { suffix: "/contacts", label: "People", icon: Users },
    { suffix: "/settings", label: "Settings", icon: Settings },
  ];

  useEffect(() => {
    let cancelled = false;
    // Keep one bounded backlog refresh in flight.
    let inflight: AbortController | null = null;
    const load = async () => {
      inflight?.abort();
      const ctrl = new AbortController();
      inflight = ctrl;
      const ceiling = setTimeout(() => ctrl.abort(), 12_000);
      try {
        const res = await fetch(`/api/orgs/${orgSlug}/pending-summary`, {
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!res.ok) return;
        const data: unknown = await res.json();
        if (!cancelled && data && typeof (data as { pendingApprovals?: unknown }).pendingApprovals === "number") {
          setPendingLive((data as { pendingApprovals: number }).pendingApprovals);
        }
      } catch {
        // Aborted (superseded/unmounted/ceiling) or a transient failure —
        // Preserve the last known backlog.
      } finally {
        clearTimeout(ceiling);
        if (inflight === ctrl) inflight = null;
      }
    };
    void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      inflight?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [orgSlug]);

  // Mirror the live pending-approvals count onto the installed PWA's home-screen
  // icon via the Badging API. Works in the foreground (installed macOS/Android
  // PWA, desktop Chrome/Edge) with no service worker — it piggybacks on the
  // count NavRail already keeps live. `setAppBadge(0)` clears per spec, but we
  // call clearAppBadge() explicitly for implementations that render a "0" dot.
  // No cleanup on unmount: the badge should persist the last-known count while
  // the app is backgrounded, and other NavRail instances (rail + mobile drawer)
  // set the same value idempotently.
  useEffect(() => {
    const nav = typeof navigator === "undefined" ? null : navigator;
    if (!nav || !("setAppBadge" in nav)) return;
    if (pendingLive > 0) {
      void nav.setAppBadge(pendingLive).catch(() => {});
    } else {
      void nav.clearAppBadge?.().catch(() => {});
    }
  }, [pendingLive]);

  return (
    <aside className={`sidebar${variant === "drawer" ? " sidebar-drawer" : ""}`}>
      <Link href={base} className="brand" aria-label="Noelle overview">
        <NoelleBrand className="nav-brand-lockup" />
      </Link>

      <Link href={`${base}/settings`} className="nav-workspace" title="Workspace settings">
        <span className="nav-workspace-avatar" aria-hidden="true">{org.name.slice(0, 1).toUpperCase()}</span>
        <span className="nav-workspace-copy"><strong>{org.name}</strong><small>Growth workspace</small></span>
        <ArrowUpRight size={15} aria-hidden="true" />
      </Link>

      <nav aria-label="Workspace" className="workspace-nav">
        {workspaceItems.map((it) => (
          <Link
            key={it.suffix || "home"}
            href={base + it.suffix}
            className={`nav-item${is(it.suffix) ? " active" : ""}`}
            aria-current={is(it.suffix) ? "page" : undefined}
            title={it.label}
            aria-label={it.count && it.count > 0 ? `${it.label}, ${it.count} pending` : it.label}
          >
            <it.icon className="nav-glyph" size={18} strokeWidth={1.75} aria-hidden="true" />
            <span className="nav-label">{it.label}</span>
            {it.count && it.count > 0 ? <span className="nav-count">{it.count}</span> : null}
          </Link>
        ))}
      </nav>

      <div className="nav-spacer" />

      <details className="nav-account">
        <summary aria-label="Account menu"><Avatar role="you" size={30} monogram={user.monogram ?? user.name.slice(0, 1).toUpperCase()} /></summary>
        <div className="nav-account-menu">
          <strong>{user.name}</strong>
          <small>{user.handle}</small>
          <form action={logoutAction}>
            <button type="submit" className="btn btn-ghost btn-sm"><LogOut size={14} aria-hidden="true" /> Log out</button>
          </form>
        </div>
      </details>
    </aside>
  );
}

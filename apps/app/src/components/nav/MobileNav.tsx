"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { AppLink as Link } from "@/components/nav/AppLink";
import { NavRail, type NavRailOrg, type NavRailUser } from "@/components/nav/NavRail";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { NoelleBrand } from "@/components/NoelleBrand";

interface MobileNavProps {
  orgSlug: string;
  org: NavRailOrg;
  user: NavRailUser;
  pendingApprovals?: number;
  logoutAction: () => void;
}

/**
 * Phone-only top bar + slide-out navigation drawer.
 *
 * Renders nothing visible above 768px (the `.mobile-topbar` is display:none on
 * desktop and the drawer panel stays off-screen). On phone it replaces the
 * fixed sidebar — which globals.css hides at ≤768px — with a hamburger bar and
 * a left slide-over panel that reuses <NavRail variant="drawer"/> so there's a
 * single source of truth for the nav items.
 *
 * Behavior: backdrop tap / Esc / route change all close it; body scroll locks
 * while open; focus moves into the panel and is trapped, then restored to the
 * hamburger on close. The drawer's NavRail mounts lazily (only after the first
 * open) so desktop never pays for a second backlog refresh.
 */
export function MobileNav({
  orgSlug,
  org,
  user,
  pendingApprovals = 0,
  logoutAction,
}: MobileNavProps) {
  const base = `/app/${orgSlug}`;
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [mounted, setMounted] = useState(false);
  const burgerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Portal target only exists on the client.
  useEffect(() => setMounted(true), []);

  // Close on navigation — tapping a nav link should dismiss the drawer.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const close = useCallback(() => setOpen(false), []);

  // While open: lock body scroll, close on Esc, and trap focus inside the
  // panel. Restore focus to the hamburger when it closes.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Move focus into the panel on the next frame (after it paints in).
    const focusTimer = window.setTimeout(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      first?.focus();
    }, 0);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusables = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) return;
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(focusTimer);
      // Return focus to the trigger so keyboard users aren't dumped at <body>.
      burgerRef.current?.focus();
    };
  }, [open]);

  const openDrawer = () => {
    setHasOpened(true);
    setOpen(true);
  };

  return (
    <>
      <header className="mobile-topbar">
        <button
          ref={burgerRef}
          type="button"
          className="mobile-topbar-burger"
          aria-label="Open navigation menu"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={openDrawer}
        >
          <span />
          <span />
          <span />
        </button>
        <Link href={base} className="mobile-topbar-brand" aria-label="Noelle overview">
          <NoelleBrand />
        </Link>
        <div className="mobile-topbar-right">
          <ThemeToggle />
        </div>
      </header>

      {mounted
        ? createPortal(
            <div className={`nav-drawer-root${open ? " open" : ""}`} aria-hidden={!open}>
              <div className="nav-drawer-backdrop" onClick={close} />
              <div
                ref={panelRef}
                className="nav-drawer-panel"
                role="dialog"
                aria-modal="true"
                aria-label="Navigation"
              >
                <button
                  type="button"
                  className="nav-drawer-close"
                  aria-label="Close navigation menu"
                  onClick={close}
                >
                  ✕
                </button>
                {hasOpened ? (
                  <NavRail
                    variant="drawer"
                    orgSlug={orgSlug}
                    org={org}
                    user={user}
                    pendingApprovals={pendingApprovals}
                    logoutAction={logoutAction}
                  />
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

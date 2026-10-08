"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

type AppLinkProps = Omit<React.ComponentPropsWithoutRef<"a">, "href"> & {
  href: string;
  /** next/link API compatibility: use router.replace instead of push. */
  replace?: boolean;
  /** Accepted for next/link API parity; intentionally ignored (see below). */
  prefetch?: boolean;
  scroll?: boolean;
  /** ms to wait for client nav to take before the hard-nav fallback fires. */
  fallbackMs?: number;
};

/**
 * Drop-in replacement for `next/link` that survives the App Router client-
 * navigation regression (vercel/next.js #57565 / #88032).
 *
 * Symptom it fixes: in production a left-click on a `<Link>` fires the RSC
 * navigation fetch but the client navigation never applies — the URL never
 * changes and the page sits there. Every link looks dead, while right-click →
 * "Open in new tab" still works (the real `<a href>` is intact). Hydration is
 * fine (verified: non-navigation buttons work); only the client router wedges.
 * It persists across 15.5.x and 16.x, with no confirmed fixed version.
 *
 * Strategy: render a real `<a href>` (so SSR, right-click, middle-click,
 * modifier-clicks, and SEO all behave natively), and on a plain left-click do
 * `router.push(href)`. If the URL hasn't changed shortly after — i.e. the
 * router silently no-op'd — fall back to a hard `window.location` navigation,
 * which always works. When the router is healthy the URL changes immediately,
 * so the fallback never fires and navigation stays client-side/SPA.
 *
 * We deliberately do NOT prefetch: the prefetch path is what corrupts the
 * client router cache in the first place, so the `prefetch` prop is ignored.
 *
 * Remove this wrapper (revert to next/link) once Next ships a release with the
 * fix verified on a preview deploy.
 */
export function AppLink({
  href,
  replace,
  prefetch: _prefetch,
  scroll: _scroll,
  fallbackMs = 300,
  onClick,
  ...rest
}: AppLinkProps) {
  const router = useRouter();

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    onClick?.(e);
    // Defer to native browser behavior for anything that isn't a plain
    // left-click on an in-app route: modifier/middle clicks, new-tab/external
    // links, hashes, mailto:, and absolute URLs.
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey ||
      rest.target === "_blank" ||
      !href.startsWith("/")
    ) {
      return;
    }

    e.preventDefault();
    const before = window.location.pathname + window.location.search;
    if (replace) router.replace(href);
    else router.push(href);

    window.setTimeout(() => {
      // URL unchanged ⇒ the client router wedged ⇒ hard-navigate.
      if (window.location.pathname + window.location.search === before) {
        if (replace) window.location.replace(href);
        else window.location.assign(href);
      }
    }, fallbackMs);
  }

  return <a href={href} onClick={handleClick} {...rest} />;
}

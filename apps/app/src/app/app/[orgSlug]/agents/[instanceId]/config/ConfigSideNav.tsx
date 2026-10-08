"use client";

import { useEffect, useState } from "react";

/**
 * Sticky side-nav for the agent config sections.
 *
 * The server version hardcoded the active state to index 0, so every
 * link looked dead — the highlight stayed pinned to "Worker routing"
 * no matter which section the user was looking at. This client version
 * (1) reflects the URL hash when one's set, (2) tracks scroll position
 * with IntersectionObserver so the highlight follows naturally as the
 * user moves down the page, and (3) updates the URL hash on click
 * without a hard navigation.
 */
export function ConfigSideNav({
  items,
}: {
  items: ReadonlyArray<{ id: string; label: string }>;
}) {
  const [active, setActive] = useState<string>(items[0]?.id ?? "");

  useEffect(() => {
    // Seed from the URL hash if one's already set (e.g. deep link).
    const hash = window.location.hash.replace(/^#/, "");
    if (hash && items.some((it) => it.id === hash)) {
      setActive(hash);
    }
  }, [items]);

  useEffect(() => {
    const sections = items
      .map((it) => document.getElementById(it.id))
      .filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;

    // Mark whichever section's top has most recently crossed into the
    // upper third of the viewport as active. Margin chosen so the
    // highlight flips just before the heading touches the top of the
    // visible area, which feels right when scrolling slowly.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort(
            (a, b) =>
              a.boundingClientRect.top - b.boundingClientRect.top,
          );
        if (visible[0]?.target?.id) {
          setActive(visible[0].target.id);
        }
      },
      {
        rootMargin: "-25% 0px -65% 0px",
        threshold: 0,
      },
    );
    sections.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [items]);

  return (
    <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <a
            key={item.id}
            href={`#${item.id}`}
            onClick={() => setActive(item.id)}
            style={{
              padding: "7px 10px",
              borderRadius: 7,
              color: isActive ? "var(--ink)" : "var(--ink-muted)",
              fontSize: 12.5,
              background: isActive ? "var(--paper-2)" : "transparent",
              fontWeight: isActive ? 500 : 400,
              textDecoration: "none",
              transition: "background 120ms ease",
            }}
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}

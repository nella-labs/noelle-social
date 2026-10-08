"use client";

import { useState } from "react";

/**
 * A harvested clip's thumbnail. IG/TikTok CDN URLs hotlink-403 and their signed
 * URLs expire, so we load them through the same-origin /clip-thumb proxy and
 * fall back to a clean branded placeholder on any failure — no broken-image
 * icons in the Discover grid.
 */
export function ClipThumb({ src, handle }: { src: string | null; handle: string }) {
  const [failed, setFailed] = useState(false);
  const showPlaceholder = !src || failed;

  if (showPlaceholder) {
    return (
      <div
        style={{
          width: "100%",
          aspectRatio: "9 / 16",
          display: "grid",
          placeItems: "center",
          background: "linear-gradient(150deg, var(--rule-soft), var(--paper))",
        }}
      >
        <div style={{ textAlign: "center", color: "var(--ink-muted)" }}>
          <div style={{ fontSize: 24, opacity: 0.55 }}>▶</div>
          <div style={{ fontSize: 10.5, marginTop: 4, fontFamily: "var(--mono)" }}>@{handle}</div>
        </div>
      </div>
    );
  }

  return (
    // Raw <img>: the src is the /clip-thumb proxy route, whose upstream is an
        // arbitrary remote clip host. next/image would need that host in
        // remotePatterns, and the set is not known ahead of time.
    <img
      src={`/clip-thumb?u=${encodeURIComponent(src)}`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      style={{ width: "100%", aspectRatio: "9 / 16", objectFit: "cover", display: "block" }}
    />
  );
}

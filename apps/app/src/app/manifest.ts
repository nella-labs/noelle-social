import type { MetadataRoute } from "next";

/**
 * Web app manifest — makes "Add to Home Screen" / PWA installs show the Noelle
 * mark + name instead of a generic screenshot tile. Next App Router serves this
 * at /manifest.webmanifest and links it automatically. The home-screen icon
 * itself (iOS) comes from app/apple-icon.png; these PNGs cover Android/desktop.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Noelle",
    short_name: "Noelle",
    description: "Your social growth workspace.",
    start_url: "/",
    display: "standalone",
    background_color: "#F3F5F9",
    theme_color: "#F3F5F9",
    icons: [
      { src: "/icons/icon-192.png?v=geometric-1", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png?v=geometric-1", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png?v=geometric-1", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

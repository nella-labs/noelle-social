import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { THEME_BOOTSTRAP } from "@/components/theme/theme-preferences";

export const metadata: Metadata = {
  title: "Noelle",
  description: "Plan content, join useful conversations, and measure your social growth.",
  applicationName: "Noelle",
  metadataBase: new URL("https://app.trynoelle.com"),
  // Standalone "Add to Home Screen" title + iOS web-app behavior. The icons
  // themselves (favicon, apple-touch-icon, manifest) are auto-detected from
  // app/icon.svg, app/apple-icon.png, and app/manifest.ts.
  appleWebApp: { capable: true, title: "Noelle", statusBarStyle: "default" },
  openGraph: {
    title: "Noelle — Your social growth workspace.",
    description:
      "An open-source workspace for social engagement, content planning, audience relationships, and measured results.",
    url: "https://app.trynoelle.com",
    siteName: "Noelle",
    images: [{ url: "/og.png?v=geometric-1", width: 1200, height: 630, alt: "Noelle" }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Noelle — Your social growth workspace.",
    description:
      "An open-source workspace for social engagement, content planning, audience relationships, and measured results.",
    images: ["/og.png?v=geometric-1"],
  },
};

// Phone-first viewport. `viewportFit: cover` lets the shell paint under the
// notch/home-indicator so the safe-area insets we apply in globals.css (the
// mobile top bar + drawer) actually have room to breathe on iOS. We keep the
// page zoomable for accessibility — never lock user-scalable.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F3F5F9" },
    { media: "(prefers-color-scheme: dark)", color: "#111827" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      data-theme="light"
      data-type="grotesk"
      data-density="regular"
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
        <Analytics />
      </body>
    </html>
  );
}

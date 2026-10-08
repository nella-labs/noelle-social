import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, ChartNoAxesCombined, MessageSquare, PenLine, Users } from "lucide-react";
import { PublicShell } from "@/components/public/PublicShell";
import { PUBLIC_PRODUCT } from "@/lib/public-product";
import styles from "./about.module.css";

export const metadata: Metadata = {
  title: "Noelle — Open-source social growth workspace",
  description: PUBLIC_PRODUCT.description,
  alternates: { canonical: "/about" },
};

const FEATURES = [
  { title: "Join useful conversations", detail: "Find relevant posts and people, review suggested replies, and manage engagement from one inbox.", icon: MessageSquare },
  { title: "Make room for your ideas", detail: "Move from a thought to a finished post. Edit drafts, prepare media, and plan your publishing week.", icon: PenLine },
  { title: "Keep relationships in view", detail: "Keep your audience and watchlists close to the conversations and content they inspire.", icon: Users },
  { title: "Learn from real activity", detail: "See review queues, publishing activity, and available post measurements. Missing data stays visible.", icon: ChartNoAxesCombined },
];

export default function AboutPage() {
  const structuredData = {
    "@context": "https://schema.org", "@type": "SoftwareApplication",
    name: PUBLIC_PRODUCT.name, description: PUBLIC_PRODUCT.description,
    applicationCategory: "BusinessApplication", operatingSystem: "Web, macOS, Linux",
    url: `${PUBLIC_PRODUCT.site}/about`, codeRepository: PUBLIC_PRODUCT.source,
    license: "https://www.apache.org/licenses/LICENSE-2.0",
  };
  return (
    <PublicShell>
      <main className={styles.main}>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, "\\u003c") }} />
        <section className={styles.hero}>
          <span className={styles.kicker}>OPEN-SOURCE SOCIAL GROWTH</span>
          <h1>Grow a presence.<br /><em>Build real connections.</em></h1>
          <p>Noelle brings engagement, content, audience relationships, and measured results into one workspace. Keep your voice and publishing decisions in your hands.</p>
          <div className={styles.actions}>
            <a href={PUBLIC_PRODUCT.links.selfHost} className="btn btn-primary">Run your own workspace <ArrowUpRight size={15} aria-hidden /></a>
            <a href={PUBLIC_PRODUCT.source} className="btn">Explore the repository <ArrowUpRight size={15} aria-hidden /></a>
          </div>
          <div className={styles.channels} aria-label="Social workflows"><span>X</span><span>LinkedIn</span><span>Reddit</span><span>Video content</span></div>
        </section>
        <section className={styles.features} aria-label="What Noelle does">
          {FEATURES.map((feature) => <article className={styles.feature} key={feature.title}><feature.icon size={22} aria-hidden /><h2>{feature.title}</h2><p>{feature.detail}</p></article>)}
        </section>
        <section className={styles.community}>
          <div><span className={styles.kicker}>MAKE IT YOURS</span><h2>A workspace you can use,<br />understand, and improve.</h2><p>Self-host Noelle, adapt the workflows, report an issue, or contribute a focused change. The source is available under Apache 2.0.</p></div>
          <nav aria-label="Project resources">
            {PUBLIC_PRODUCT.guides.map((guide) => <a href={guide.href} key={guide.href}>{guide.label} <ArrowUpRight size={15} aria-hidden /></a>)}
            <Link href="/">Open an existing workspace <ArrowUpRight size={15} aria-hidden /></Link>
          </nav>
        </section>
      </main>
    </PublicShell>
  );
}

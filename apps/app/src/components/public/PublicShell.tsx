import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { NoelleBrand } from "@/components/NoelleBrand";
import { PUBLIC_PRODUCT } from "@/lib/public-product";
import styles from "./public-shell.module.css";

export function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/about" aria-label="About Noelle"><NoelleBrand /></Link>
        <nav aria-label="Public navigation">
          <Link href="/about" className="btn btn-ghost btn-sm">About</Link>
          <a href={PUBLIC_PRODUCT.source} className="btn btn-sm">Source <ArrowUpRight size={14} aria-hidden /></a>
          <Link href="/" className="btn btn-primary btn-sm">Open workspace</Link>
        </nav>
      </header>
      {children}
      <footer className={styles.footer}><span>Noelle · Social growth workspace</span><a href={PUBLIC_PRODUCT.links.license}>Apache 2.0</a><a href={PUBLIC_PRODUCT.links.documentation}>Documentation</a></footer>
    </div>
  );
}

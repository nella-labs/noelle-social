import { Database, Send } from "lucide-react";
import styles from "./connections.module.css";
import {
  listApifyConnections,
  getApifySpendByToken,
  getXApiConnection,
} from "@/lib/queries";
import { ApifyConnectionCard } from "./ApifyConnectionCard";
import { XApiConnectionCard } from "./XApiConnectionCard";

interface ConnectionsPanelProps {
  orgId: string;
  orgSlug: string;
}

export async function ConnectionsPanel({ orgId, orgSlug }: ConnectionsPanelProps) {
  const [apifyConns, apifySpend, xapiConn] = await Promise.all([
    listApifyConnections(orgId),
    getApifySpendByToken(orgId),
    getXApiConnection(orgId),
  ]);

  return (
    <div className={styles.panels}>
      <section className={styles.section}>
        <div className={styles.sectionHeading}><span className={styles.sectionIcon}><Database size={20} aria-hidden /></span><div><h2>Data sources</h2><p>Connect the sources your agents use to discover and research. Apify usage stays visible for each token.</p></div></div>
        <ApifyConnectionCard orgSlug={orgSlug} connections={apifyConns} spend={apifySpend} />
      </section>
      <section className={styles.section}>
        <div className={styles.sectionHeading}><span className={styles.sectionIcon}><Send size={19} aria-hidden /></span><div><h2>X posting</h2><p>The X account Vega uses for posts and replies through the official API.</p></div></div>
        <XApiConnectionCard orgSlug={orgSlug} connection={xapiConn} />
      </section>
    </div>
  );
}

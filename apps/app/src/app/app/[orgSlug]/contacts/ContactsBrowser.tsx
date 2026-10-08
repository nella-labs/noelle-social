"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { normalizeLinkedinHandle } from "@/lib/utils";
import type { PersonListItem } from "@/lib/queries";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { PaginationControl } from "@/components/ui/PaginationControl";
import { ContactRow } from "@/components/contacts/ContactRow";
import styles from "@/components/contacts/contacts.module.css";

type WatchFilter = "all" | "watched" | "cold";
type PlatformFilter = "all" | "x" | "linkedin";
const CONTACTS_PAGE_SIZE = 100;

export function ContactsBrowser({ orgSlug, people, styleSourceKeys = [] }: {
  orgSlug: string;
  people: PersonListItem[];
  styleSourceKeys?: string[];
}) {
  const styleKeys = new Set(styleSourceKeys);
  const isStyleSource = (person: PersonListItem) => person.xHandle != null && styleKeys.has(`x:${person.xHandle.toLowerCase()}`) || person.linkedinHandle != null && styleKeys.has(`linkedin:${normalizeLinkedinHandle(person.linkedinHandle)}`);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<WatchFilter>("all");
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [page, setPage] = useState(1);
  const search = query.trim().toLowerCase().replace(/^@/, "");
  const watchedCount = people.filter((person) => person.watchedBy.length > 0).length;
  const xCount = people.filter((person) => person.platforms.includes("x")).length;
  const linkedinCount = people.filter((person) => person.platforms.includes("linkedin")).length;
  const filtered = people.filter((person) => {
    const matchesSearch = !search || person.displayName?.toLowerCase().includes(search) || person.xHandle?.toLowerCase().includes(search) || person.linkedinHandle?.toLowerCase().includes(search);
    const matchesWatch = filter === "all" || (filter === "watched" ? person.watchedBy.length > 0 : person.watchedBy.length === 0);
    return Boolean(matchesSearch) && matchesWatch && (platform === "all" || person.platforms.includes(platform));
  });
  const narrowed = Boolean(search) || filter !== "all" || platform !== "all";
  const pageCount = Math.max(1, Math.ceil(filtered.length / CONTACTS_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  if (page !== currentPage) setPage(currentPage);
  const visible = filtered.slice((currentPage - 1) * CONTACTS_PAGE_SIZE, currentPage * CONTACTS_PAGE_SIZE);

  return (
    <section className={styles.browser} aria-label="Contacts browser">
      <div className={styles.toolbar}>
        <div className={styles.heading}><div><h3>People</h3><p>Build a clearer picture of every connection.</p></div><span className="tag">{narrowed ? `${filtered.length} / ${people.length}` : people.length} contacts</span></div>
        <label className={styles.search}><Search size={16} aria-hidden /><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search by handle or name…" aria-label="Search contacts" /></label>
        <div className={styles.filters}>
          <SegmentedControl value={filter} onChange={(value) => { setFilter(value as WatchFilter); setPage(1); }} label="Filter contacts by watchlist membership" options={[["all", `All ${people.length}`], ["watched", `Watched ${watchedCount}`], ["cold", `Not watched ${people.length - watchedCount}`]]} />
          <SegmentedControl value={platform} onChange={(value) => { setPlatform(value as PlatformFilter); setPage(1); }} label="Filter contacts by platform" options={[["all", "All platforms"], ["x", `X ${xCount}`], ["linkedin", `LinkedIn ${linkedinCount}`]]} />
        </div>
      </div>
      <div className={styles.listPanel}>
        {filtered.length > CONTACTS_PAGE_SIZE && <PaginationControl page={currentPage} pageSize={CONTACTS_PAGE_SIZE} totalRows={filtered.length} onPageChange={setPage} label="Contacts pagination" />}
        <div className={styles.columnHead}><span>Contact</span><span>Platforms</span><span>Replies</span><span>Last interaction</span><span /></div>
        {people.length === 0 ? <div className={styles.empty}>No contacts yet. People appear here when you add them to an agent&apos;s watchlist.</div> : filtered.length === 0 ? <div className={styles.empty}>No contacts match these filters.<button className="btn btn-sm" onClick={() => { setQuery(""); setFilter("all"); setPlatform("all"); setPage(1); }}>Clear filters</button></div> : <ul className={styles.list}>{visible.map((person) => <ContactRow key={person.id} person={person} orgSlug={orgSlug} styleSource={isStyleSource(person)} />)}</ul>}
        <PaginationControl page={currentPage} pageSize={CONTACTS_PAGE_SIZE} totalRows={filtered.length} onPageChange={setPage} label="Contacts pagination at end" />
      </div>
    </section>
  );
}

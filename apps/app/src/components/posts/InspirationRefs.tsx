import type { InspirationRef } from "@noelle/contracts";

/**
 * "Inspired by" list shown on both idea cards and draft cards, so the operator
 * can see who/what a post drew from and avoid copy-pasting them. Each ref links
 * to the source post / profile when a URL is present.
 */
export function InspirationRefs({ refs }: { refs?: InspirationRef[] | null }) {
  if (!refs?.length) return null;
  return (
    <div className="idea-refs">
      <span className="eyebrow">Inspired by</span>
      <ul className="idea-refs__list">
        {refs.map((ref, i) => (
          <li key={i} className="idea-ref">
            {ref.url ? (
              <a href={ref.url} target="_blank" rel="noreferrer" className="idea-ref__link">
                {refLabel(ref)}
              </a>
            ) : (
              <span>{refLabel(ref)}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function refLabel(ref: InspirationRef): string {
  const kind =
    ref.kind === "watchlist_post" ? "watchlist"
    : ref.kind === "keyword_post" ? "keyword"
    : ref.kind === "replied_post" ? "replied post"
    : ref.kind === "playbook" ? "playbook"
    : "vault";
  const who = ref.author ? `@${ref.author}` : kind;
  return ref.note ? `${who} · ${ref.note}` : who;
}

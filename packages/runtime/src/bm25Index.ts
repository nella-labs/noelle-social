/**
 * BM25 index over markdown chunks, backed by MiniSearch.
 *
 * Wraps the library so the rest of the runtime sees a tiny, typed
 * interface: pass in chunks, get a `ChunkIndex` you can `.search()` on.
 * Tokenisation, stemming, and stopword choices live here so we can
 * tune them in one place.
 *
 * Design choices:
 *   - Tokenisation: lowercased, punctuation stripped, length ≥ 2.
 *     MiniSearch's default `[\s\-]+` split is too narrow (it keeps
 *     `voice-and-style` as one token); we want `voice` AND `style` to
 *     both be indexed.
 *   - Stemming: light Porter-style stemming (built-in via term
 *     preprocessor) so `shipping` ~ `ships` ~ `shipped`.
 *   - Stopwords: a short English list (~25 words) — keeping the list
 *     small avoids dropping search-meaningful tokens like "agent" or
 *     "system".
 *   - Fields indexed: `body` only. Heading paths are not indexed
 *     separately in v1; their tokens already appear in the chunk body
 *     (the `## <title>` line is the first line). Future option: boost
 *     headingPath tokens — out of scope here.
 *
 * Embeddings are an explicit future option (see plan §"Out of scope").
 * The chunk shape (path, headingPath, lines) is embedding-ready: a
 * follow-up can add a dense field next to the BM25 lexical one.
 */

import MiniSearch, { type SearchResult } from "minisearch";
import type { MarkdownChunk } from "./markdownChunker.js";
import { searchResultLimit } from "./searchLimit.js";

export interface ChunkSearchResult {
  chunk: MarkdownChunk;
  score: number;
  highlights: ReadonlyArray<string>;
}

export interface ChunkIndex {
  search(query: string, topK: number): ReadonlyArray<ChunkSearchResult>;
}

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "of", "in", "on", "to", "for",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "this",
  "that", "these", "those", "with", "as", "at", "by",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** Very small suffix-stripper. Covers the common English plural/-ing cases. */
function stem(token: string): string {
  if (token.length <= 4) return token;
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.endsWith("sses")) return token.slice(0, -2);
  if (token.endsWith("ing")) {
    const stripped = token.slice(0, -3);
    if (
      stripped.length >= 3 &&
      stripped[stripped.length - 1] === stripped[stripped.length - 2]
    ) {
      return stripped.slice(0, -1);
    }
    return stripped;
  }
  if (token.endsWith("ed")) return token.slice(0, -2);
  if (token.endsWith("es")) return token.slice(0, -2);
  if (token.endsWith("s")) return token.slice(0, -1);
  return token;
}

interface IndexedDoc {
  id: number;
  body: string;
}

export function buildChunkIndex(
  chunks: ReadonlyArray<MarkdownChunk>,
): ChunkIndex {
  const docs: IndexedDoc[] = chunks.map((c, i) => ({ id: i, body: c.body }));

  const ms = new MiniSearch<IndexedDoc>({
    fields: ["body"],
    storeFields: [],
    idField: "id",
    tokenize: (text: string) => tokenize(text),
    processTerm: (term: string) => stem(term),
    searchOptions: {
      combineWith: "OR",
      prefix: false,
      fuzzy: false,
    },
  });
  ms.addAll(docs);

  return {
    search(query, topK) {
      topK = searchResultLimit(topK, chunks.length);
      if (!query.trim() || topK === 0) return [];
      const raw = ms.search(query, { combineWith: "OR" }) as SearchResult[];
      // Build a stem → original-query-token map so highlights surface
      // the user's terms ("shipping") rather than internal stems ("ship").
      const queryTokens = tokenize(query);
      const stemToOrig = new Map<string, string>();
      for (const tok of queryTokens) {
        const s = stem(tok);
        if (!stemToOrig.has(s)) stemToOrig.set(s, tok);
      }
      const out: ChunkSearchResult[] = [];
      for (const r of raw) {
        const idx = typeof r.id === "number" ? r.id : Number(r.id);
        const chunk = chunks[idx];
        if (!chunk) continue;
        const terms = Array.isArray(r.terms) ? (r.terms as string[]) : [];
        const highlights = terms.map((t) => stemToOrig.get(t) ?? t);
        // Normalize out MiniSearch's "quality" multiplier. Its public score is
        // `innerSum * queryTerms.length` (dist/es/index.js:1289-1294), so when the
        // caller queries with a whole post text, a long keyword-dense chunk that
        // incidentally matches many query terms scores astronomically (observed in
        // prod: 233 … 108_573) — which makes a fixed relevance threshold a no-op.
        // Dividing by the matched-query-term count collapses the score back to the
        // honest OR-sum of per-term BM25+ contributions: bounded, comparable across
        // posts of very different length, and still rewarding genuine multi-term
        // overlap. Use queryTerms (matched QUERY terms), not terms (doc-side, which
        // diverges from queryTerms only under prefix/fuzzy — both disabled here).
        const queryTerms = (r as { queryTerms?: unknown }).queryTerms;
        const queryTermCount = Array.isArray(queryTerms) ? queryTerms.length : terms.length;
        const rawScore = typeof r.score === "number" ? r.score : 0;
        out.push({
          chunk,
          score: rawScore / Math.max(queryTermCount, 1),
          highlights,
        });
        if (out.length >= topK) break;
      }
      return out;
    },
  };
}

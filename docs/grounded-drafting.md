# Grounded drafting + verifier loop

How the drafter (Vega/X, Lyra/LinkedIn) grounds a reply in the right context and
checks its own work before queuing it for human approval.

## The pipeline

```
              ┌─ Person brief    (watchlist profile)
  lead ─ gather ┼─ Voice anchors   (voice-scoped retrieval — BM25, opt. ⊕ dense)
  (cheap,     ├─ Knowledge anchors (knowledge-scoped retrieval — BM25, opt. ⊕ dense)
   parallel)  ├─ Image caption   (vision pass over the post's image)
              └─ Memory          (past approved/edited drafts; crowd negatives)
                     │
              [optional distill → one compact "drafting brief"]
                     │
                 DRAFTER ──► variants
                     │
              VERIFIER (judge: voice · grounding · relevance · format)
                ├ pass → /api/outbound → approvals (verdict attached)
                └ fail → regenerate w/ feedback (≤ retries), then queue best
                         tiered: 1 cheap judge · 3 adversarial for watchlist
```

Optional retrieval and verification steps retain their existing configuration
and fail-open behavior: if retrieval, vision, synthesizer or judge calls fail,
drafting continues through the existing fallback. The shared editorial guidance
described below is always included in generator prompts.

## What each piece fixes

### Structure and evidence review

The shared writing contract in `packages/runtime/src/writingStructure.ts` is
injected into the social generators and existing judges. It asks for supported
points, earned endings, truthful uncertainty, relevant specificity and
context-led variation. The full StoryScope statement ledger
and 12 adopted rules distinguish research findings
from social-writing adaptations.

The existing reply judge now receives up to 20 recent feed replies, with each
entry limited to 220 characters, only for reviews containing public replies.
In mixed sets, this feed-history check applies only to those public replies;
DM-only and repost-only reviews omit it. It can assess repeated sequences of ideas and
endings within the existing voice/relevance criteria. This complements the
deterministic word-overlap `diversity` score; that score does not measure semantic
structure. Per-person `novelty` still uses that person's history. Reddit now
passes its already-loaded prior/recent replies into verification and includes
novelty/diversity when choosing the best regeneration. A passing Reddit attempt
takes precedence over any failing attempt, even if its total score is lower.
When every attempt fails, the existing highest-total fallback remains.

Nova's idea generator, script generator and script judge receive the same structural guidance.
The changes add no model calls, new score dimension, sending permission, or retry
loop. Generators receive the guidance regardless of verifier configuration;
judge checks run when the existing verification setting is enabled.

A short warm response, a clear procedural explanation and a factual mixed result
can all be appropriate. The rubric does not require fiction's subplots, twists,
nonlinear chronology or ambiguity. It is not an authorship detector or a
paper-validated quality score for social content.

| Gap (verified) | Fix |
|---|---|
| X drafter never read `x_watchlist_profiles` (profiler output orphaned) | Profile is loaded per tick and injected as a "WHO YOU'RE REPLYING TO" block (always on; no-op when the author isn't a profiled watchlist person) |
| Only **watchlist** people were ever profiled, so people we actually talk to had no profile to inject. Verified 2026-07-28: 6 LinkedIn people with 6–17 SENT replies each (56 replies) had never been profiled, and 1 X + 1 LinkedIn profile were orphaned (person off the watchlist ⇒ never refreshed again). | Both profilers now also queue anyone with more than `PROFILER_MIN_REPLIES` (default **5**) SENT replies (`listRepliedPeopleNeedingProfile`, merged watchlist-first in `lib/profiler-queue.ts`). On LinkedIn this is a read-only queue widening, **not** a watchlist auto-promote — promoting would make the person intro-DM eligible. See `docs/linkedin-intern.md`. |
| Retrieval was voice-only; no product/positioning facts | Second **knowledge-scoped** retrieval pass injects "PRODUCT KNOWLEDGE" the reply may assert |
| No check after drafting | **Verifier** grades voice/grounding/relevance/format; regenerates on fail |
| Drafts leaned on the "not X, it's Y" / "is X, not Y" contrastive-reframe (antithesis) crutch as a default sentence shape | The ideation + post/reply prompts forbid it (mirrors the LinkedIn reply HARD BAN), and the verifier's deterministic `format` check applies a **strong reframe penalty** — one lean drops below the pass bar so the draft regenerates, a stack drives it near zero. Deliberately **not** a hard zero: a rare, genuinely-best single contrast can still be queued (`draftVerifier.ts` `REFRAME_PATTERNS`). |
| Edited drafts (best learning signal) never captured | Editable review panels + `/api/drafts/:id/save-edit` populate `edited_body` |
| Post images unseen | Discovery captures `images[]`; a vision pass (a multimodal Claude/Gemini call) describes the image, the caption is injected into the drafter prompt AND the verifier judge, and the drafter is told to engage with what the image shows when it's central. On the self-host VM (no Gemini key, Vertex ADC dead) the caption runs through **Bedrock Claude** so it actually fires there. |
| Drafter replied to comments buried under a post, not the post | Discovery now tags each lead `is_reply` (kaito reply flags, or `conversationId ≠ id`) and, with `excludeReplies` (**now on by default**), drops replies on **both** lanes so the agent answers original posts. |
| Drafter invented first-person stats about the operator | Vega drafted *"24 followers over here…"* on 2026-07-24 with the real number ~100. **Both halves are now fixed:** every drafter prompt carries a hard ban on stating a self-number that isn't in a facts block, and the drafter is *given* the real counts via a **YOUR OWN ACCOUNT** block (below). |

### The "24 followers" incident (2026-07-24)

Worth reading before touching this, because the obvious half-fix does not work.

Vega drafted `24 followers over here and i still show up like the room is full`.
The number 24 appears nowhere in Noelle. Two independent causes stacked:

1. **Nothing ever told the drafter its own follower count.** The voice rules
   reward concrete numbers, and the NEVER-DO list forbade fabricating facts about
   the *lead* — nothing covered the *operator*. A pre-existing "inventing
   specifics… must be real" rule was already in `SYSTEM_X_BASE` and did not stop
   it: telling a model a number must be real is inert when it has no way to know
   which of its numbers are real.
2. **The one follower number the system held was stale and structurally
   fragile.** `own_post_metrics.author_follower_count` was a by-product of
   re-measuring *published posts*, so it went dark 30 days after the last post —
   and it had been frozen at 68 since 2026-07-11 because the whole Apify token
   pool was exhausted (`no usable Apify token — all 52 are exhausted or invalid`).

The fix therefore needs a read path that depends on neither recent publishing nor
Apify: `GET /2/users/me` on the official X API (one read per sweep, no write
budget), written to the `own_account` bus bucket by
`apps/x-intern/src/workers/own-account-tick.ts` (Apify stays as a fallback for
instances with no connected X account). `renderOwnAccountBlock` then renders it
into the prompt — and **always renders a block, even with no snapshot**, because
the failure mode is the model filling a gap it did not know was a gap. A snapshot
older than `OWN_ACCOUNT_MAX_AGE_DAYS` (3) reports the count as unknown rather
than passing off a drifted number as current, and a `null` count is never
rendered as `0` (the drafter says these numbers out loud).

## Configuration (worker env)

Same flags on both `apps/x-intern` and `apps/linkedin-intern`:

| Env | Default | Effect |
|---|---|---|
| `NOELLE_VOICE_DIRS` | _(empty)_ | Comma-separated vault subdirs to scope **voice** retrieval to (e.g. `02-brand`). Empty → search the whole vault, as today. |
| `NOELLE_KNOWLEDGE_DIRS` | _(empty)_ | Vault subdirs for the **knowledge** pass (e.g. `01-business,04-automation-contexts`). Empty → no knowledge pass. |
| `NOELLE_DRAFTER_KNOWLEDGE_TOPK` | `4` | Chunks retrieved in the knowledge pass. |
| `NOELLE_DRAFTER_GROUNDING_RERANK` | `false` | Voyage-rerank the **grounding** anchors. The KB ranks lexically (BM25); when on, the drafter pulls a wider BM25 pool and reranks it to the final topK with `rerank-2.5`, so voice + knowledge anchors are chosen by semantic fit, not just keyword overlap. Fail-open to the BM25 order (no `VOYAGE_API_KEY` / any error). `lib/grounding.ts`. |
| `NOELLE_KB_DENSE` | `false` | **Hybrid dense retrieval inside `kb.search()`** (shared by every agent — see below). When on, the KnowledgeBase fuses its BM25 ranking with a Voyage **`voyage-context-4`** contextualized-embedding ranking (RRF), so anchors that are semantically on-topic but lexically disjoint still surface. Fail-open to pure BM25 (flag off, no key, any error). Operates one layer below `NOELLE_DRAFTER_GROUNDING_RERANK` (which reranks whatever `kb.search` returns). |
| `NOELLE_KB_DENSE_RERANK` | `false` | Within the dense lane, also run `rerank-2.5` over the fused top pool (one extra call per search, reorder-only). Redundant if `NOELLE_DRAFTER_GROUNDING_RERANK` is already on. |
| `NOELLE_KB_DENSE_MODEL` / `NOELLE_KB_DENSE_DIM` / `NOELLE_KB_DENSE_POOL` | `voyage-context-4` / `1024` / `50` | Dense lane model, output dimension, and candidate-pool size. Defaults are almost always right. |
| `NOELLE_DRAFTER_VERIFY` | `false` | Run the post-draft verifier + regenerate loop. |
| `NOELLE_DRAFTER_VERIFY_RETRIES` | `2` | Max regenerations on a failing verdict before considering the best attempt. |
| `NOELLE_DRAFTER_VOICE_FLOOR` | `0.65` | X and LinkedIn skip ordinary replies below this voice score after retries. Explicit requests and notification replies remain available for human review with their actual verdict. Requires verification; `0` disables this floor. |
| `NOELLE_X_AUTOSEND_REQUIRE_VERIFY` (X only) | `false` | Fail-CLOSED auto-send: an auto-post requires a genuine passing verifier verdict (verify ran, the judge actually returned via `judgeOk`, every dimension cleared the bar); verify-off / judge-unavailable / fail ⇒ hold for manual approval. No-op when off. The manual-approval path is untouched in both states. |
| `NOELLE_DRAFTER_VERIFY_CHEAP` (X only) | `false` | Route the post-draft verifier JUDGE through the cheap Haiku tier instead of the drafter's Sonnet/Opus routing. The judge only scores against the rubric (it never gates the queue), so grading on the drafter model was pure spend — this matches the LinkedIn intern's `judgeRouting()`. Default OFF → judge uses the drafter routing, unchanged. |
| `NOELLE_VISION_BEDROCK` (X only) | `true` | Fallback for image understanding when the org has no `gemini-api-key`: caption the post's image(s) via a vision-capable Claude on AWS Bedrock (same creds the classifier uses). No-op / fail-open when no AWS creds. This is what makes Vega "see" images on the self-host VM. |
| `NOELLE_X_OWN_ACCOUNT` (X only) | `true` | Refresh the operator's own handle + follower/following/post counts onto the `own_account` bus bucket, so the drafter states a real number instead of inventing one. One `GET /2/users/me` read per sweep (no write budget); Apify fallback when no X account is connected. Turning it OFF does not re-enable invented numbers — the prompt ban is unconditional — it just leaves every count unknown. |
| `NOELLE_X_OWN_ACCOUNT_MS` (X only) | `43200000` (12h) | Own-account sweep cadence. ~60 X API reads/month, comfortably inside the free tier's read cap. |

X applies configured faithful voices even when the global style switch is off, honors `styleExemplarKinds`, and keeps its assigned reply shape. Tiny reactions can stand alone; the writer and reviewer should not add an explanation merely to make them more specific.

The **reply-to-original-posts** filter lives in the discovery config (not the
drafter env): `excludeReplies` on `agent_instances.discovery_config` /
`run_config`, **default ON**. It adds X's `-filter:replies` to the keyword lane
and drops `is_reply` leads client-side on the watchlist lane. Flip it off
per-instance to let the agent answer replies/thread comments again.

> **Pick the dirs from your vault layout.** For example: voice ≈
> `voice`; knowledge ≈ `knowledge`, `product-context`. Set these
> once on the worker env; the dir → category split is the only operator input
> the knowledge grounding needs.

## Cost

Per typical lead: +1 knowledge retrieval (no LLM) and, when the verifier is on,
+1 cheap judge call. A high-value watchlist lead with a bad first draft adds the
3-judge adversarial panel + up to `RETRIES` redraft+judge rounds. Guards: the
relevance gate still skips no-signal non-priority leads before any of this;
adversarial + retries are gated to watchlist/priority; retries are capped.

With `NOELLE_KB_DENSE` on, add: one corpus contextualized-embed per KB rebuild
(amortized over the 15-min TTL window; the vault is small, well inside Voyage's
120k-token/request ceiling) and one small query-embed per `kb.search`. All
fail-open, so a Voyage outage costs nothing but a silent fall back to BM25.

### Prompt caching (default OFF, Bedrock/Anthropic only)

The drafter's system prompt is a large, byte-stable base (persona + voice rules,
~2-3k tokens) followed by a small per-lead suffix. Two opt-in env flags let the
Anthropic/Bedrock backends cache that base so it is not re-billed on the initial
draft OR any verify-driven regenerate (the 3-calls-per-lead win). Both are
**transparent to the model** — the drafted text is byte-for-byte identical to the
no-cache path; this is purely a token-cost optimization, no account-behavior change.

- `NOELLE_PROMPT_CACHE_ENABLED=1` — the drafter passes `systemCachePrefixLen`
  (the exact char length of the static prefix, via
  `drafterSystemCachePrefixLen`); the backend caches just that prefix and leaves
  the per-lead suffix uncached.
- `NOELLE_PROMPT_CACHE_SYSTEM=1` — caches the WHOLE system block for the
  byte-stable drafter buckets (`drafter`, `drafter-codex`, `drafter-verify`).

Both default OFF (only the exact string `"1"` enables; unset/`"0"`/anything-else
= no cache marker, request byte-identical to today). Only the Bedrock and
Anthropic backends honor them; vertex/openai/gemini/claude-cli ignore the fields.
Fail-open at every step: an out-of-range prefix length degrades to no-cache; a
block under the provider's min cacheable size silently no-ops; and a runtime
rejection of the `cache_control` block is caught and retried ONCE without the
breakpoint, so a draft never fails because caching was on. Cached tokens are
folded back into `input_tokens` at full input price (`effectiveInputTokens`) so
spend is never under-counted and a budget cap can never be slipped past.
See `packages/runtime/src/promptCache.ts`.

## Hybrid dense retrieval (`voyage-context-4`)

The KnowledgeBase's retrieval is lexical (BM25) by default. Setting
`NOELLE_KB_DENSE=1` on a worker adds a **contextualized dense lane** _inside_
`kb.search()`, fused with BM25 via Reciprocal Rank Fusion:

- **Why `voyage-context-4`.** The vault is chunked at heading boundaries
  (`markdownChunker.ts`). `voyage-context-4` embeds each file's chunks
  *together*, so a chunk vector stays aware of its surrounding section instead
  of being embedded as an orphan — exactly the shape our corpus already has.
- **Shared by every agent, present and future.** The lane lives in
  `createLocalFsKnowledgeBase` — the one factory Vega (X), Lyra (LinkedIn),
  Orion (Reddit), Nova, and any future agent build their KB from. There is **no
  per-agent wiring**: flip the env on a worker and that agent's `kb.search()`
  is hybrid. Embeddings are held **in memory**, rebuilt on the same
  watch/TTL/signature cycle as the BM25 index (no new DB, no migration).
- **The relevance gate is provably unaffected.** The drafter skips a
  non-priority lead when `max(anchor.score) < relevanceThreshold` (default 6, a
  BM25-scale number). In hybrid mode the reported `KbHit.score` *stays the BM25
  score* (dense-only chunks carry 0), and a guard keeps the top-BM25 chunk in
  the returned window — so `max(score)` is identical to the pure-BM25 path.
  Dense **reorders and augments** the anchors (better answers, more recall in
  the ungated knowledge pass); it never moves the skip bar. Letting dense also
  drive the gate would be a deliberate, separate drafter change.
- **Endpoint/key.** The lane calls Voyage **directly**
  (`api.voyageai.com/v1/contextualizedembeddings`) — the MongoDB gateway used
  by `rerank-2.5` / `voyage-3-large` is not assumed to proxy it. Key resolves
  `VOYAGE_CONTEXT_API_KEY` then the shared `VOYAGE_API_KEY`; override the base
  with `VOYAGE_CONTEXT_ENDPOINT` if your gateway does support the endpoint.

## Verdict surfacing

When the verifier runs, its verdict (`pass`, per-dimension scores, reasons,
attempt count) rides the outbound payload as `verifierMeta` and is stored on
each draft's `payload.verifier_meta`. It does **not** gate the queue — a
failed-then-best draft is still queued, with the verdict attached, for the human.

## Code map

- `packages/runtime/src/drafting/draftVerifier.ts` — `verifyDrafts` / `verifyTiered` (judge injected).
- `packages/runtime/src/drafting/contextAssembly.ts` — `synthesizeBrief` / `renderBriefBlock` (the optional distill).
- `packages/runtime/src/drafting/visionCaption.ts` — `captionImages` / `createGeminiCaptionFn` (BYO key) / `createVertexCaptionFn` (Vertex ADC) / `createBedrockCaptionFn` (Claude vision on Bedrock — the self-host path where there's no `gemini-api-key` and Vertex ADC is dead).
- `packages/x-apify/src/index.ts` — `normalizeTweet` sets `is_reply`; `apps/x-intern/src/workers/discovery-tick.ts` drops replies when `excludeReplies`.
- `packages/runtime/src/{knowledgeBase,gcsAnchorSource,nellaClient}.ts` — `filterDirs` dir-scoped search; `knowledgeBase.ts` also hosts the hybrid dense lane (`hybridSearch`, `resolveKbDense`).
- `packages/runtime/src/voyageContextEmbed.ts` — `voyage-context-4` contextualized-embedding client (`voyageContextEmbed` / `voyageContextEmbedQuery`), fail-open.
- `packages/runtime/src/denseChunkIndex.ts` — pure in-memory cosine index (`buildDenseIndex`); `rrf.ts` provides the RRF fusion both lanes share.
- `apps/{x,linkedin}-intern/src/workers/drafter-tick.ts` — retrieval passes + verify/regenerate loop.
- `apps/x-intern/src/lib/own-account.ts` — the own-account snapshot type, bus read/write, staleness rule, and `renderOwnAccountBlock` (the YOUR OWN ACCOUNT block).
- `apps/x-intern/src/workers/own-account-tick.ts` — the sweep (X API primary, Apify fallback), hosted in the ideation worker beside the own-POST sweep.
- `apps/x-intern/src/lib/x-api-client-factory.ts` — shared `buildXApiClient` (used by content-publish + the own-account sweep).
- `apps/api-vm/src/routes/drafts.ts` — `POST /api/drafts/:id/save-edit` (captures the edit).
- `apps/app/src/components/approvals/*` — editable draft panels.

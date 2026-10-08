import { z } from "zod";

/**
 * @noelle/contracts — agent objective + targeting.
 *
 * Two shapes:
 *   1. ObjectiveSchema       — the operator's mission string. Persisted to
 *                              noelle.agent_instances.objective.
 *   2. TargetingProposalSchema — the diff the Vega chat proposes and the
 *                              operator confirms. The chat LLM emits this in a
 *                              fenced `noelle-proposal` block; the route
 *                              validates it here and never lets the model write
 *                              the DB directly. The Apply button replays the
 *                              validated proposal through the applyTargetingChange
 *                              server action (assertOrgMember-gated).
 *
 * Handles are normalised (leading @ stripped, lowercased) so the proposal a
 * user confirms matches exactly what the discovery worker queries and what the
 * x_watchlist UNIQUE(agent_instance_id, kind, value) constraint dedupes on.
 */

export const OBJECTIVE_MAX = 600;
export const HANDLE_MAX = 80;
export const KEYWORD_MAX = 200;
/** LinkedIn vanity slug (`linkedin.com/in/<slug>`). Slugs run up to ~100 chars. */
export const PUBLIC_ID_MAX = 120;
/** Max entries the chat may add/remove in a single proposal — keeps one turn
 * from inserting hundreds of rows. The manual UI has no such cap. */
export const TARGETING_LIST_MAX = 25;

/**
 * Reduce a LinkedIn profile reference to its bare vanity slug (`public_id`).
 *
 * The LinkedIn intern (Lyra) keys watched people by `public_id` — the
 * `linkedin.com/in/<slug>` slug — because LinkedIn has no @handle. The chat
 * operator may paste a full URL, a `/in/<slug>` path, or a bare slug; this
 * collapses all three to the slug, lowercased, with any trailing slash, query,
 * or hash removed.
 *
 *   https://www.linkedin.com/in/jane-doe/   → "jane-doe"
 *   linkedin.com/in/jane-doe?x=1            → "jane-doe"
 *   /in/jane-doe                            → "jane-doe"
 *   Jane-Doe                                → "jane-doe"
 *
 * Returns "" when no slug can be recovered (e.g. an empty string or a URL with
 * no `/in/` segment); callers should drop empties.
 */
export function linkedinPublicId(input: string): string {
  let s = input.trim();
  if (!s) return "";
  // Strip query + hash first so they never leak into the slug.
  s = s.split(/[?#]/)[0] ?? "";
  // Pull the slug out of an /in/<slug> path when present (handles full URLs and
  // bare `/in/...` paths alike); otherwise treat the whole input as the slug.
  const match = s.match(/\/in\/([^/]+)/i);
  if (match) {
    s = match[1] ?? "";
  } else if (/linkedin\.com/i.test(s)) {
    // A LinkedIn URL without an /in/ segment isn't a personal profile slug.
    return "";
  }
  // Drop any leading/trailing slashes left over and lowercase.
  return s.replace(/^\/+|\/+$/g, "").trim().toLowerCase();
}

/** Normalize the subreddit references accepted by the manual watchlist and chat. */
export function normalizeSubreddit(raw: string): string | null {
  let value = raw.trim();
  const urlMatch = value.match(/^(?:https?:\/\/)?(?:[a-z0-9-]+\.)?reddit\.com\/r\/([A-Za-z0-9_]+)(?:[/?#]|$)/i);
  if (urlMatch) value = urlMatch[1]!;
  else value = value.replace(/^\/?r\//i, "").replace(/^\/+|\/+$/g, "");
  return /^[A-Za-z0-9_]{1,30}$/.test(value) ? value.toLowerCase() : null;
}

export const SubredditSchema = z.string().trim().max(200).transform(normalizeSubreddit)
  .pipe(z.string().min(1, "Could not read a subreddit name"));

export const ObjectiveSchema = z
  .string()
  .trim()
  .min(1, "Objective cannot be empty")
  .max(OBJECTIVE_MAX, `Objective must be ${OBJECTIVE_MAX} characters or fewer`);
export type Objective = z.infer<typeof ObjectiveSchema>;

/** A watchlist handle: @ stripped, lowercased, trimmed. */
export const HandleSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/^@+/, "").trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(1, "Handle cannot be empty")
      .max(HANDLE_MAX, `Handle must be ${HANDLE_MAX} characters or fewer`),
  );

/** A watchlist keyword: trimmed, bounded. */
export const KeywordSchema = z
  .string()
  .trim()
  .min(1, "Keyword cannot be empty")
  .max(KEYWORD_MAX, `Keyword must be ${KEYWORD_MAX} characters or fewer`);

/**
 * A LinkedIn watchlist person, normalised to its bare `public_id` slug. The
 * chat may pass a full profile URL, a `/in/<slug>` path, or a bare slug — all
 * collapse to the slug (lowercased) via `linkedinPublicId`. Inputs that yield
 * no slug fail validation so they never reach the apply path.
 */
export const PublicIdSchema = z
  .string()
  .trim()
  .transform(linkedinPublicId)
  .pipe(
    z
      .string()
      .min(1, "Could not read a LinkedIn profile slug")
      .max(PUBLIC_ID_MAX, `Slug must be ${PUBLIC_ID_MAX} characters or fewer`),
  );

/** Dedupe + cap a normalised list, preserving first-seen order. */
function normaliseList(max: number) {
  return (list: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of list) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
      if (out.length >= max) break;
    }
    return out;
  };
}

const HandleList = z
  .array(HandleSchema)
  .default([])
  .transform(normaliseList(TARGETING_LIST_MAX));
const KeywordList = z
  .array(KeywordSchema)
  .default([])
  .transform(normaliseList(TARGETING_LIST_MAX));
const PublicIdList = z
  .array(PublicIdSchema)
  .default([])
  .transform(normaliseList(TARGETING_LIST_MAX));
const SubredditList = z.array(SubredditSchema).default([]).transform(normaliseList(TARGETING_LIST_MAX));

/**
 * The diff a platform chat proposes and the operator confirms.
 *
 * The X (Vega) fields are `addHandles`/`removeHandles`/`addKeywords`/
 * `removeKeywords` (X has handle + keyword discovery). The LinkedIn (Lyra)
 * fields are `addPeople`/`removePeople` — `public_id` slugs, since LinkedIn has
 * no @handle and no keyword discovery. `mission` is shared. A given proposal is
 * one platform's shape; the apply path rejects fields for another role.
 * Reddit uses normalized subreddit names in `addSubreddits`/`removeSubreddits`.
 */
export const TargetingProposalSchema = z
  .object({
    /** Present (and valid) iff the proposal changes the mission. Omit for "no change". */
    mission: ObjectiveSchema.optional(),
    addHandles: HandleList,
    removeHandles: HandleList,
    addKeywords: KeywordList,
    removeKeywords: KeywordList,
    /** LinkedIn: people to start drafting for, normalised to `public_id` slugs. */
    addPeople: PublicIdList,
    /** LinkedIn: people to stop drafting for, normalised to `public_id` slugs. */
    removePeople: PublicIdList,
    addSubreddits: SubredditList,
    removeSubreddits: SubredditList,
  })
  .strict()
  .refine(
    (p) =>
      p.mission !== undefined ||
      p.addHandles.length > 0 ||
      p.removeHandles.length > 0 ||
      p.addKeywords.length > 0 ||
      p.removeKeywords.length > 0 ||
      p.addPeople.length > 0 ||
      p.removePeople.length > 0 ||
      p.addSubreddits.length > 0 ||
      p.removeSubreddits.length > 0,
    { message: "Proposal must change at least one thing." },
  )
  .refine((p) => [
    [p.addHandles, p.removeHandles], [p.addKeywords, p.removeKeywords],
    [p.addPeople, p.removePeople], [p.addSubreddits, p.removeSubreddits],
  ].every(([adds, removes]) => !adds!.some((value) => removes!.includes(value))),
  { message: "A target cannot be added and removed in the same proposal." });
export type TargetingProposal = z.infer<typeof TargetingProposalSchema>;

/** True when the proposal touches any platform watchlist, rather than only the mission. */
export function proposalTouchesWatchlist(p: TargetingProposal): boolean {
  return (
    p.addHandles.length > 0 ||
    p.removeHandles.length > 0 ||

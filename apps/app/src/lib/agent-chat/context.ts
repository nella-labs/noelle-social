/**
 * Per-role live snapshot loader for the agent chat surface.
 *
 * Each chat turn builds the system prompt from two halves:
 *
 *   persona (static, declared in @noelle/agents/chat/<role>.ts)
 *     +  snapshot (dynamic, fetched here from Cloud SQL)
 *     →  system prompt the route sends to Bedrock
 *
 * The agent class itself can't query the DB — packages/agents is
 * dashboard-bundle safe (no postgres.js, no Cloud SQL connector). So
 * loaders live in the app layer and produce the `AgentChatContext`
 * shape declared in `@noelle/agents/chat`.
 *
 * Tenancy: every loader piggybacks on `getAgentInstance(instanceId)`,
 * which calls `assertOrgMember` before returning the row. Direct
 * queries below scope by `inst.org_id` after that guard.
 *
 * Failure mode: loaders are best-effort. If a query throws (DB blip,
 * schema drift, permission), the loader logs and returns an empty
 * partial — the chat profile gracefully degrades to a persona-only
 * prompt instead of erroring the whole turn.
 */
import type {
  AgentChatContext,
  ChatApprovalSummary,
  ChatLeadSummary,
  ChatTargeting,
  ChatVideoDraft,
  ChatVideoInspiration,
  ChatVideoIntel,
  ChatWorkerFreshness,
} from "@noelle/agents/chat";
import { sql } from "@/lib/db";
import { approvalMemoryJoins, replyApprovalContextSql, trimMemorySql, visibleDraftBodySql } from "@noelle/runtime";
import { measuredSourceRatio, readSourceCount } from "@noelle/runtime/source-values";
import { buildXReplyUrl } from "@/lib/x-reply-url";
import { buildXPostUrl } from "@/lib/x-post-url";
import type { NoelleAgentInstance } from "@/lib/db-types";
import { SKIP_MARKERS } from "@/lib/is-skip-draft";
import {
  draftPayload,
  leadPayload,
  linkedinLeadPayload,
  redditLeadFields,
  bodyForSelectedAngle,
  selectedDraftAngle,
  type DraftPayloadView,
  type LeadPayloadView,
} from "@/lib/payload-shapes";

const TOP_APPROVALS = 5;
const TOP_LEADS = 8;
const X_INTERN_WORKERS = ["discovery", "classifier", "drafter", "send"] as const;

/**
 * Per-turn options the route threads in from the request. Today only the video
 * intern uses `draftId` — the Drafts studio passes the id of the draft the
 * founder is refining so the chat can ground its answers in that exact video.
 */
export interface ChatContextOptions {
  draftId?: string | null;
}

export async function loadChatContextForInstance(
  inst: NoelleAgentInstance,
  opts: ChatContextOptions = {},
): Promise<AgentChatContext> {
  switch (inst.role) {
    case "x_intern":
    case "linkedin_intern":
    case "reddit_intern":
      return loadReplyInternContext(inst);
    case "video_intern":
      return loadVideoInternContext(inst, opts);
    default:
      return {};
  }
}

async function loadInternWatchlist(inst: NoelleAgentInstance): Promise<string[]> {
  if (inst.role !== "reddit_intern") return loadLinkedInWatchlist(inst);
  const rows = await sql<{ subreddit: string }[]>`
    select subreddit from noelle.reddit_watchlist
    where agent_instance_id = ${inst.id} and org_id = ${inst.org_id}
    order by added_at asc limit 40
  `;
  return rows.map((row) => `r/${row.subreddit}`);
}

/** The people Lyra watches — name (or public id), her whole targeting model. */
async function loadLinkedInWatchlist(inst: NoelleAgentInstance): Promise<string[]> {
  const rows = await sql<Array<{ name: string | null; public_id: string | null }>>`
    select name, public_id
    from noelle.linkedin_watchlist_people
    where agent_instance_id = ${inst.id} and org_id = ${inst.org_id}
    order by added_at asc
    limit 40
  `;
  return rows
    .map((r) => r.name?.trim() || (r.public_id ? `in/${r.public_id}` : null))
    .filter((v): v is string => !!v);
}

const VIDEO_INTERN_WORKERS = [
  "harvester",
  "teardown",
  "distiller",
  "ideator",
  "scripter",
] as const;

/**
 * Live snapshot for the Video Growth Intern (Nova) chat.
 *
 * Nova's targeting is creators (`video_watchlist_sources`) + niche keyword
 * lanes (`video_watchlist_niches`); its real intelligence is the distilled
 * Brand Guide (`video_ultra_profiles.profile->>'summary'`) and the top
 * harvested clips by views (`video_clips`). With those in the snapshot the chat
 * can name the actual creators it watches and ground "what's working" in the
 * real distillation + real metrics. Best-effort — any failing sub-query
 * degrades to the persona-only prompt, like the other loaders.
 */
async function loadVideoInternContext(
  inst: NoelleAgentInstance,
  opts: ChatContextOptions = {},
): Promise<AgentChatContext> {
  const ctx: AgentChatContext = {};
  if (inst.objective && inst.objective.trim()) ctx.objective = inst.objective.trim();

  const [targeting, freshness, intel, currentDraft] = await Promise.all([
    loadVideoTargeting(inst).catch((err) => {
      console.warn("[agent-chat] failed to load video targeting", err);
      return { handles: [], keywords: [] } as ChatTargeting;
    }),
    loadWorkerFreshness(VIDEO_INTERN_WORKERS).catch((err) => {
      console.warn("[agent-chat] failed to load video worker freshness", err);
      return [] as ChatWorkerFreshness[];
    }),
    loadVideoIntel(inst).catch((err) => {
      console.warn("[agent-chat] failed to load video intel", err);
      return { brandGuide: [], topClips: [] } as ChatVideoIntel;
    }),
    opts.draftId
      ? loadVideoCurrentDraft(inst, opts.draftId).catch((err) => {
          console.warn("[agent-chat] failed to load current video draft", err);
          return null;
        })
      : Promise.resolve(null),
  ]);

  ctx.targeting = targeting;
  if (freshness.length > 0) ctx.workerFreshness = freshness;
  if (intel.brandGuide.length > 0 || intel.topClips.length > 0) ctx.videoIntel = intel;
  if (currentDraft) ctx.currentDraft = currentDraft;
  return ctx;
}

/**
 * The single draft the founder is refining in the studio — loaded by id, scoped
 * to the instance + org (IDOR guard: a draft id from another org returns no
 * row). Pulls the hook, timed beats (storyboard), last-saved script, the
 * on-screen visual labels, the soundtrack, and the creators it was modeled on,
 * so Nova's "Refine" chat can quote and rewrite the real lines on screen.
 */
async function loadVideoCurrentDraft(
  inst: NoelleAgentInstance,
  draftId: string,
): Promise<ChatVideoDraft | null> {
  const rows = await sql<Array<{
    idea_hook: string | null;
    status: string | null;
    structure: unknown;
    script: string | null;
    final_script: string | null;
    graph_specs: unknown;
    sounds: unknown;
    inspiration_clip_ids: string[] | null;
  }>>`
    select i.hook as idea_hook, d.status, d.structure, d.script, d.final_script,
           d.graph_specs, d.sounds, i.inspiration_clip_ids
    from noelle.video_drafts d
    join noelle.video_ideas i on i.id = d.idea_id
    where d.id = ${draftId}
      and d.agent_instance_id = ${inst.id} and d.org_id = ${inst.org_id}
    limit 1
  `;
  const r = rows[0];
  if (!r) return null;

  const beats = (Array.isArray(r.structure) ? r.structure : []) as Array<Record<string, unknown>>;
  const sounds = (Array.isArray(r.sounds) ? r.sounds : []) as Array<Record<string, unknown>>;
  const specs = (Array.isArray(r.graph_specs) ? r.graph_specs : []) as Array<Record<string, unknown>>;

  // Resolve the inspiration clip ids → the exemplar reels WITH their teardown
  // (the same grounding the scripter used: video_clips LEFT JOIN video_teardowns).
  // id::text = any(...) avoids the uuid-cast throw on seed/non-uuid ids (see the
  // scripter crash fix in docs). Best-effort: a failure just drops the grounding.
  const ids = Array.isArray(r.inspiration_clip_ids) ? r.inspiration_clip_ids.filter(Boolean) : [];
  let inspirations: ChatVideoInspiration[] = [];

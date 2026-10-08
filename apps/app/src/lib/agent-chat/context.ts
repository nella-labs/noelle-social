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
  if (ids.length) {
    const clipRows = await sql<Array<{
      author_handle: string;
      views: string | null;
      author_follower_count: string | null;
      why_it_worked: string | null;
      hook_text: string | null;
    }>>`
      select c.author_handle,
             c.views::text as views,
             c.author_follower_count::text as author_follower_count,
             t.teardown->>'whyItWorked'        as why_it_worked,
             t.teardown->'hook'->>'text'        as hook_text
      from noelle.video_clips c
      left join noelle.video_teardowns t on t.clip_id = c.id
      where c.agent_instance_id = ${inst.id} and c.org_id = ${inst.org_id}
        and c.id::text = any(${ids})
      order by c.views desc nulls last
    `;
    inspirations = clipRows.map((c) => {
      const views = readSourceCount(c.views);
      const followers = readSourceCount(c.author_follower_count);
      const reach = measuredSourceRatio(views, followers);
      return {
        handle: normaliseHandle(c.author_handle) ?? c.author_handle,
        views,
        reachMultiple: reach,
        hook: c.hook_text?.trim() || undefined,
        whyItWorked: c.why_it_worked?.trim() || undefined,
      };
    });
  }
  const inspiredBy = [...new Set(inspirations.map((c) => c.handle).filter(Boolean))];

  return {
    hook: (r.idea_hook ?? "").trim(),
    status: r.status ?? "draft",
    beats: beats.map((b) => ({
      tStart: numVal(b.tStart),
      tEnd: numVal(b.tEnd),
      purpose: String(b.purpose ?? "").trim(),
      line: String(b.line ?? "").trim(),
    })),
    script: (r.final_script ?? r.script ?? "").trim(),
    visuals: specs.map(specLabel).filter((v): v is string => !!v),
    sounds: sounds
      .map((s) => String(s.name ?? s.trackName ?? "").trim())
      .filter((v): v is string => !!v),
    inspiredBy,
    inspirations,
  };
}

/** Coerce a possibly-string/undefined JSON number to a finite number (0 fallback). */
function numVal(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** A short human label for an on-screen visual spec (chart title / kind). */
function specLabel(raw: Record<string, unknown>): string {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const kind = typeof raw.kind === "string" ? raw.kind.trim() : "";
  if (title && kind) return `${title} (${kind})`;
  return title || kind || "visual";
}

/** Nova's targeting: enabled watched creators + enabled niche lanes. */
async function loadVideoTargeting(inst: NoelleAgentInstance): Promise<ChatTargeting> {
  const [creators, niches] = await Promise.all([
    sql<Array<{ handle: string }>>`
      select handle from noelle.video_watchlist_sources
      where agent_instance_id = ${inst.id} and org_id = ${inst.org_id} and enabled = true
      order by created_at asc
      limit 40
    `,
    sql<Array<{ query: string }>>`
      select query from noelle.video_watchlist_niches
      where agent_instance_id = ${inst.id} and org_id = ${inst.org_id} and enabled = true
      order by created_at asc
      limit 40
    `,
  ]);
  return {
    handles: creators.map((r) => r.handle),
    keywords: niches.map((r) => r.query),
  };
}

/** The distilled Brand Guide + the strongest harvested clips by views. */
async function loadVideoIntel(inst: NoelleAgentInstance): Promise<ChatVideoIntel> {
  const [guides, clips] = await Promise.all([
    // The distiller stores the human-readable "what performs" line under
    // profile->>'whatPerforms' (apps/video-intern/src/lib/distill.ts), not
    // 'summary' — read the real key so the Brand Guide isn't silently empty.
    sql<Array<{ scope: string; subject: string; summary: string | null; clips_analyzed: number | null }>>`
      select scope, subject, profile->>'whatPerforms' as summary, clips_analyzed
      from noelle.video_ultra_profiles
      where agent_instance_id = ${inst.id} and org_id = ${inst.org_id}
      order by refreshed_at desc nulls last
      limit 8
    `,
    // Bigint text preserves nullable measurements for the shared count reader.
    sql<Array<{ author_handle: string; views: string | null; caption: string | null }>>`
      select author_handle, views::text as views, caption
      from noelle.video_clips
      where agent_instance_id = ${inst.id} and org_id = ${inst.org_id}
      order by views desc nulls last
      limit 6
    `,
  ]);
  return {
    brandGuide: guides
      .filter((g) => g.summary && g.summary.trim())
      .map((g) => ({
        scope: g.scope === "niche" ? "niche" : g.scope === "account" ? "account" : "creator",
        subject: g.subject === "me" ? "your account" : g.subject,
        summary: (g.summary ?? "").trim(),
        clipsAnalyzed: g.clips_analyzed ?? null,
      })),
    topClips: clips.map((c) => ({
      handle: normaliseHandle(c.author_handle) ?? c.author_handle,
      views: readSourceCount(c.views),
      caption: (c.caption ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
    })),
  };
}

async function loadReplyInternContext(
  inst: NoelleAgentInstance,
): Promise<AgentChatContext> {
  const [approvals, totals, freshness, targeting, bestLeads] = await Promise.all([
    loadTopPendingApprovals(inst).catch((err) => {
      console.warn("[agent-chat] failed to load pending approvals", err);
      return undefined;
    }),
    loadApprovalTotals(inst).catch((err) => {
      console.warn("[agent-chat] failed to load approval totals", err);
      return { pending: undefined, sentLifetime: undefined };
    }),
    loadWorkerFreshness(inst.role === "x_intern" ? X_INTERN_WORKERS : ["discovery", "classifier", "drafter"]).catch((err) => {
      console.warn("[agent-chat] failed to load worker freshness", err);
      return [] as ChatWorkerFreshness[];
    }),
    (inst.role === "x_intern" ? loadTargeting(inst) : loadInternWatchlist(inst).then((handles) => ({ handles, keywords: [] }))).catch((err) => {
      console.warn("[agent-chat] failed to load targeting", err);
      return undefined;
    }),
    loadBestLeads(inst).catch((err) => {
      console.warn("[agent-chat] failed to load best leads", err);
      return undefined;
    }),
  ]);

  const ctx: AgentChatContext = { pendingApprovals: approvals };
  if (totals.pending !== undefined) ctx.totalPendingCount = totals.pending;
  if (totals.sentLifetime !== undefined) ctx.totalSentLifetime = totals.sentLifetime;
  if (freshness.length > 0) ctx.workerFreshness = freshness;
  // Custom objective only — the chat profile phrases the "no custom mission"
  // case itself (it knows the default brief).
  if (inst.objective && inst.objective.trim()) ctx.objective = inst.objective.trim();
  ctx.targeting = targeting;
  ctx.bestLeads = bestLeads;
  return ctx;
}

/**
 * The best current leads straight off `noelle.leads` — broader than the
 * approvals queue (includes leads not yet drafted), ranked tier → score →
 * recency, scoped to today. Gives the chat a real answer to "show me the
 * best leads", with the available source-platform link per lead.
 */
async function loadBestLeads(inst: NoelleAgentInstance): Promise<ChatLeadSummary[]> {
  type LeadRow = {
    l_author_handle: string | null;
    l_tier: string | null;
    l_classifier_score: string | null;
    l_post_id: string | null;
    l_post_text: string | null;
    l_payload: unknown;
    has_draft: boolean;
  };
  // The tweet id lives in the `external_id` column and the post body in
  // `payload->>'text'` (the discovery worker never writes post_id/post_text
  // into payload) — coalesce so links/text are real. Same fallback chain the
  // speedrun path uses (apps/app/src/lib/to-speedrun-draft.ts).
  //
  // Window = last 24h ("today's" leads); status past the classifier so every
  // row has a tier/score worth ranking. Leads already drafted AND waiting in
  // the approval queue are excluded here — they show in the queue snapshot
  // (with a prefilled reply link) instead, so the two lists don't overlap.
  const rows = await sql<LeadRow[]>`
    select
      l.author_handle                                       as l_author_handle,
      l.tier                                                as l_tier,
      l.classifier_score                                    as l_classifier_score,
      coalesce(l.payload->>'post_id', l.external_id)        as l_post_id,
      coalesce(l.payload->>'post_text', l.payload->>'text') as l_post_text,
      l.payload as l_payload,
      exists(select 1 from noelle.drafts d where d.lead_id = l.id and d.org_id=l.org_id) as has_draft
    from noelle.leads l
    where l.agent_instance_id = ${inst.id}
      and l.org_id = ${inst.org_id}
      and exists(select 1 from noelle.agent_instances owner where owner.id=l.agent_instance_id
        and owner.org_id=l.org_id and owner.role=${inst.role} and owner.role=l.platform||'_intern')
      and l.status in ('classified', 'drafting', 'drafted')
      and l.created_at >= now() - interval '1 day'
      and not exists (
        select 1 from noelle.approvals a
        join noelle.drafts d on d.id = a.draft_id
        where a.lead_id = l.id and a.status = 'pending' and ${replyApprovalContextSql(sql)}
      )
    order by
      case l.tier when 'T1' then 1 when 'T2' then 2 when 'T3' then 3 else 4 end,
      l.classifier_score desc nulls last,
      l.created_at desc
    limit ${TOP_LEADS}
  `;
  return rows.map((r) => {
    const source = replySource(inst, r.l_payload);
    return toChatLeadSummary({
      authorHandle: r.l_author_handle,
      tier: r.l_tier,
      classifierScore: r.l_classifier_score,
      postId: r.l_post_id,
      postText: source.postText ?? r.l_post_text,
      hasDraft: r.has_draft,
      platform: inst.role === "x_intern" ? "x" : inst.role === "linkedin_intern" ? "linkedin" : "reddit",
      postUrl: source.postUrl,
    });
  });
}

/**
 * Pure row → ChatLeadSummary mapper (exported for unit tests). Builds the
 * original-post and reply-composer links from the handle + post id.
 */
export function toChatLeadSummary(row: {
  authorHandle: string | null;
  tier: string | null;
  classifierScore: string | null;
  postId: string | null;
  postText: string | null;
  hasDraft: boolean;
  platform?: "x" | "linkedin" | "reddit";
  postUrl?: string | null;
}): ChatLeadSummary {
  const handle = normaliseHandle(row.authorHandle);
  const postId = row.postId ?? null;
  const url = row.platform && row.platform !== "x" ? row.postUrl ?? null : buildXPostUrl({ handle, tweetId: postId });
  return {
    handle,
    tier: normaliseTier(row.tier),
    score: parseScore(row.classifierScore, undefined),
    postText: row.postText ?? "",
    postId,
    originalPostUrl: url,
    replyUrl: row.platform && row.platform !== "x" ? url : url ? buildXReplyUrl(postId) : null,
    hasDraft: row.hasDraft,
  };
}

/**
 * What the X intern is currently hunting for — its x_watchlist. Lets the chat
 * tell the founder the current targeting and propose precise diffs against it.
 */
async function loadTargeting(inst: NoelleAgentInstance): Promise<ChatTargeting> {
  const rows = await sql<{ kind: "handle" | "keyword"; value: string }[]>`
    select kind, value
    from noelle.x_watchlist
    where agent_instance_id = ${inst.id} and org_id = ${inst.org_id}
    order by created_at asc
  `;
  return {
    handles: rows.filter((r) => r.kind === "handle").map((r) => r.value),
    keywords: rows.filter((r) => r.kind === "keyword").map((r) => r.value),
  };
}

async function loadTopPendingApprovals(
  inst: NoelleAgentInstance,
): Promise<ChatApprovalSummary[]> {
  type JoinedRow = {
    a_id: string;
    a_created_at: string;
    d_payload: unknown;
    l_tier: string | null;
    l_classifier_score: string | null;
    l_author_handle: string | null;
    l_payload: unknown;
    l_external_id: string | null;
    l_post_text: string | null;
  };

  const rows = await sql<JoinedRow[]>`
    select
      a.id              as a_id,
      a.created_at      as a_created_at,
      d.payload         as d_payload,
      l.tier            as l_tier,
      l.classifier_score as l_classifier_score,
      l.author_handle   as l_author_handle,
      l.payload         as l_payload,
      l.external_id     as l_external_id,
      coalesce(l.payload->>'post_text', l.payload->>'text') as l_post_text
    from noelle.approvals a
    join noelle.drafts d on d.id = a.draft_id
    join noelle.leads l on l.id = a.lead_id
    cross join lateral(select ${visibleDraftBodySql(sql, true)} as text) visible_body
    where a.agent_instance_id = ${inst.id}
      and a.org_id = ${inst.org_id} and ${replyApprovalContextSql(sql)}
      and l.platform = ${inst.role.replace(/_intern$/, "")}
      and a.status = 'pending'
      and ${trimMemorySql(sql, sql`visible_body.text`)} <> ''
      and not (${trimMemorySql(sql, sql`visible_body.text`)} ~* '^SKIP:')
      and not exists(select 1 from unnest(${SKIP_MARKERS}::text[]) marker where strpos(lower(visible_body.text),marker)>0)
    order by l.classifier_score desc nulls last, a.created_at desc
    limit ${TOP_APPROVALS}
  `;

  const out: ChatApprovalSummary[] = [];
  for (const r of rows) {
    const draft = readDraftPayload(r.d_payload);
    const lead = readLeadPayload(r.l_payload);
    const source = replySource(inst, r.l_payload);
    const selectedAngle = selectedDraftAngle(draft);
    const draftBody = bodyForSelectedAngle(draft);
    if (draftBody === undefined) continue;

    // post_id lives in the external_id column for discovery-produced leads;
    // fall back to it so the reply link is a real threaded reply, not a new
    // tweet. Mirrors apps/app/src/lib/to-speedrun-draft.ts.
    const postId = lead.post_id ?? r.l_external_id ?? null;
    out.push({
      approvalId: r.a_id,
      authorHandle: normaliseHandle(draft.replyTarget?.kind === "comment" ? draft.replyTarget.author ?? null : r.l_author_handle ?? source.authorHandle ?? null),
      postText: source.postText ?? lead.post_text ?? r.l_post_text ?? "",
      selectedAngle,
      draftBody,
      tier: normaliseTier(r.l_tier),
      velocityScore: parseScore(r.l_classifier_score, lead.velocity_score),
      createdAt: r.a_created_at,
      postId,
      // Reply link prefilled with the drafted reply — "click to send".
      replyUrl: draft.kind === "dm" ? null : inst.role === "x_intern" ? buildXPostUrl({ handle: r.l_author_handle, tweetId: postId }) ? buildXReplyUrl(postId, draftBody) : null
        : draft.replyTarget?.kind === "comment" ? draft.replyTarget.permalink ?? null : source.postUrl,
    });
  }
  return out;
}

async function loadApprovalTotals(
  inst: NoelleAgentInstance,
): Promise<{ pending?: number; sentLifetime?: number }> {
  const rows = await sql<Array<{ pending: number; sent_lifetime: number }>>`
    select count(*) filter(where a.status='pending' and ${replyApprovalContextSql(sql)})::int as pending,
      count(*) filter(where a.status in ('sent','skipped'))::int as sent_lifetime
    from noelle.approvals a ${approvalMemoryJoins(sql)}
    where a.org_id=${inst.org_id} and a.agent_instance_id=${inst.id} and ai.role=${inst.role}
  `;
  const r = rows[0];
  if (!r) return {};
  return { pending: r.pending, sentLifetime: r.sent_lifetime };
}

async function loadWorkerFreshness(
  workers: ReadonlyArray<ChatWorkerFreshness["worker"]>,
): Promise<ChatWorkerFreshness[]> {
  const rows = await sql<Array<{ worker: string; last_success_at: string | null }>>`
    select
      worker,
      max(finished_at) filter (where error is null) as last_success_at
    from noelle.worker_runs
    where worker = any(${workers as unknown as string[]})
    group by worker
  `;
  const byWorker = new Map(rows.map((r) => [r.worker, r.last_success_at] as const));
  return workers.map((worker) => ({
    worker,
    lastSuccessAt: byWorker.get(worker) ?? null,
  }));
}

/**
 * `draftPayload` / `leadPayload` expect a full row but only read `.payload`.
 * The join above projects the payload column directly, so we shim the
 * minimal shape — the unused row fields are never inspected by the readers.
 */
function readDraftPayload(payload: unknown): DraftPayloadView {
  if (!payload) return draftPayload(null);
  return draftPayload({ payload } as unknown as Parameters<typeof draftPayload>[0]);
}

function readLeadPayload(payload: unknown): LeadPayloadView {
  if (!payload) return leadPayload(null);
  return leadPayload({ payload } as unknown as Parameters<typeof leadPayload>[0]);
}

function replySource(inst: NoelleAgentInstance, payload: unknown): { postText: string | null; postUrl: string | null; authorHandle: string | null } {
  if (inst.role === "reddit_intern") return redditLeadFields(payload);

import type { Logger } from "../lib/logger.js";
import type { ActiveInstance } from "../lib/activation.js";
import type { CodexRunner } from "../lib/codex-runner.js";
import type { PostDraftCreate, PostVerifierMeta } from "@noelle/contracts";
import { parseBrandConfig, brandConfigHasContent } from "@noelle/contracts";
import { renderBrandBlock } from "../lib/prompts.js";
import {
  type DraftToVerify,
  type VerifierCall,
  type VerifyContext,
  type AgentRole,
  type ModelRouting,
  verifyTiered,
  toOutboundVerifierMeta,
} from "@noelle/runtime";
import { stripEmDashes } from "@noelle/runtime/voice-sanitize";
import { stripExternalLinksForPost } from "@noelle/runtime";
import { linkedinInternRouting } from "../lib/routing.js";
import type { ApprovedIdea } from "../lib/post-ideas-db.js";
import {
  type PostDraftContext,
  type PostCta,
  type PostStyleSelection,
  PostOutputSchema,
  buildPostDrafterSystem,
  renderPostDrafterPrompt,
  safeJsonParse,
} from "../lib/post-drafter.js";
import { communityForVariant, type XCommunity } from "../lib/x-communities.js";
import { selectStyleExemplars } from "@noelle/runtime";
import {
  boundedPostKnowledgeAnchors,
  renderPostFactualContext,
} from "../lib/post-drafter-context.js";
import type { StyleExemplarRow, UltraProfileRow } from "../lib/account-feeder-db.js";

// LinkedIn posts have no hard char cap like X's 250; we still keep them tight.
const POST_CHAR_LIMIT = 1300;
// Per-platform verifier char limit for the post-drafter fan-out. X is a hard
// 280; reddit is generous (rarely a target in 0.0.x, kept for completeness).
const CHAR_LIMIT: Record<string, number> = { linkedin: POST_CHAR_LIMIT, x: 280, reddit: 10000 };

// On a FRESH full generate (no pending subset), X yields multiple distinct
// versions for the operator to pick from; platforms absent here yield one. A per-platform
// "+ Version"/regen (a pending subset) always adds exactly one.
const FRESH_VERSIONS: Record<string, number> = { x: 3 };

export interface RunPostDrafterTickArgs {
  log: Logger;
  instance: ActiveInstance;
  /** The claimed approved ideas (claimApprovedIdeas). */
  ideas: ApprovedIdea[];
  /** Per-idea context gather (voice/inspiration/playbooks/notes). Injected. */
  gather: (idea: ApprovedIdea) => Promise<PostDraftContext>;
  runner: Pick<CodexRunner, "draft">;
  /** Agent role for spend attribution. Defaults to linkedin_intern (the LinkedIn
   *  path, unchanged); the post-drafter passes x_intern for X-owned ideas. */
  agentRole?: AgentRole;
  /** Model routing for the draft + verifier calls. Defaults to
   *  linkedinInternRouting(instance); the post-drafter passes X routing for
   *  X-owned ideas. */
  routing?: ModelRouting;
  /** Verifier judges. Empty = verification off unless a request forces review. */
  makeVerifierCalls: (opts?: { force?: boolean }) => VerifierCall[];
  /** Max regenerate attempts on a failing verdict. */
  verifyRetries: number;
  /** Pushes the finished post to the api-vm (HMAC /api/post-drafts). */
  sink: (draft: PostDraftCreate) => Promise<{ draft_id: string }>;
  /** Return a failed idea to 'approved' for a retry. */
  release: (ideaId: string) => Promise<void>;
  /** Clear an idea's pending_platforms once it's (re)drafted. Optional (tests). */
  clearPending?: (ideaId: string) => Promise<void>;
  /** Sign-off CTA (product/url/tagline) the post ends with. Omit = follow-ask only. */
  cta?: PostCta;
  // ---- F8: post-style injection (default OFF, fail-open) ----------------------
  // When NOELLE_POST_STYLE is on and the corpus has been populated by the Account
  // Feeder, the post-drafter tick loads this pool ONCE and reuses it across all
  // ideas in the batch. An empty array or undefined ⇒ no STYLE block (exactly
  // today's behavior). Errors in selectStyleExemplars fail open: the post is
  // drafted without a style block rather than failing the idea.
  /**
   * Pre-loaded account_style_posts (kind='post') candidate pool. Loaded once per
   * tick and shared across all ideas in the batch to avoid N×DB reads. Empty or
   * undefined → no style injection (behavior unchanged from today).
   */
  stylePool?: StyleExemplarRow[];
  /**
   * Pre-loaded account ultra profiles. Used to render the style notes block
   * alongside the exemplar bodies. Empty or undefined → styleNotes="".
   */
  styleUltraProfiles?: UltraProfileRow[];
  /**
   * Whether the post-style gate (NOELLE_POST_STYLE) is on. Defaults to false so
   * the tests that don't pass this field stay on the gate-off path. Also forced on
   * by the caller when a style source is PINNED (an explicit pin overrides the env
   * gate).
   */
  postStyleEnabled?: boolean;
  /**
   * Config passed to selectStyleExemplars. Defaults to instance.account_feeder_config.
   * The caller overrides it for a PINNED source (pinnedSelectConfig bumps the
   * exemplar count + drops variety) so the named voice actually transfers.
   */
  styleConfig?: unknown;
  /** Forward to selectStyleExemplars for tests (Voyage fetch mock). */
  styleFetchImpl?: typeof fetch;
  /** Forward to selectStyleExemplars for tests (Voyage API key override). */
  styleApiKey?: string;
}

/**
 * Draft one post per approved idea: gather context, write the post (Opus-tier
 * `post-drafter` bucket), sanitize, optionally verify + regenerate, and push to
 * the api-vm. Never publishes. Returns how many drafts were created.
 */
export async function runPostDrafterTick(args: RunPostDrafterTickArgs): Promise<number> {
  const { log, instance, ideas, gather, runner, makeVerifierCalls, verifyRetries, sink, release } =
    args;
  // Spend attribution + routing default to the LinkedIn path (unchanged); the
  // post-drafter overrides both for X-owned ideas (Vega).
  const agentRole: AgentRole = args.agentRole ?? "linkedin_intern";
  const routing: ModelRouting = args.routing ?? linkedinInternRouting(instance);
  let created = 0;

  // The operator's brand (same brand_config the reply drafter uses), parsed once.
  const brand = parseBrandConfig(instance.brand_config);
  const brandBlock = brandConfigHasContent(brand) ? renderBrandBlock(brand) : null;

  // F8: style pool is pre-loaded once per tick (injected by the caller so the
  // tick stays DB-free in tests). An empty / absent pool means gate-off behavior.
  const stylePool = args.stylePool ?? [];
  const styleUltraProfiles = args.styleUltraProfiles ?? [];
  const postStyleEnabled = args.postStyleEnabled ?? false;

  // Draft ONE post for a single (idea, platform) pair: build the platform's
  // system prompt + char limit, write, sanitize, verify+regenerate, and push.
  // Returns 1 on a pushed draft, 0 on a parse fail (caller skips that platform).
  async function draftOnePlatform(p: {
    platform: string;
    idea: ApprovedIdea;
    ctx: PostDraftContext;
    /** X-only: the community this variant is framed for (null = no framing). */
    community?: XCommunity | null;
    generationComplete?: boolean;
  }): Promise<number> {
    const { platform, idea, ctx, community, generationComplete } = p;

    // F8 style injection is LinkedIn-only (the exemplar corpus is LinkedIn
    // posts). Fails open to null → no STYLE block → today's behavior.
    let styleSelection: PostStyleSelection | null = null;
    if (platform === "linkedin" && postStyleEnabled && stylePool.length > 0) {
      const queryText = [idea.hook, idea.thesis ?? ""].join(" ").trim();
      styleSelection = await selectStyleExemplars(queryText, stylePool, styleUltraProfiles, {
        enabled: true, // gate already checked above
        config: args.styleConfig ?? instance.account_feeder_config,
        ...(args.styleApiKey !== undefined ? { apiKey: args.styleApiKey } : {}),
        ...(args.styleFetchImpl !== undefined ? { fetchImpl: args.styleFetchImpl } : {}),
      }).catch((err: unknown) => {
        log.warn(
          { idea: idea.id, err: String(err) },
          "post-style select failed; drafting without style",
        );
        return null;
      });
    }

    const system = buildPostDrafterSystem(
      platform,
      instance.objective ?? null,
      brandBlock,
      args.cta,
      styleSelection,
      community ?? null,
    );
    const basePrompt = renderPostDrafterPrompt(ctx);

    const draftOnce = async (prompt: string): Promise<PostAttempt | null> => {
      const res = await runner.draft({
        bucket: "post-drafter",
        routing,
        orgId: instance.org_id,
        instanceId: instance.id,
        worker: "post-drafter",
        agentRole,
        system,
        prompt,
      });
      const parsed = PostOutputSchema.safeParse(safeJsonParse(res.text));
      if (!parsed.success) return null;
      // Prepare every attempt before review so its verdict covers the body saved.
      const body = stripExternalLinksForPost(stripEmDashes(parsed.data.body));
      return body ? { body, engine: res.engine, model: res.model } : null;
    };

    const firstRaw = await draftOnce(basePrompt);
    if (!firstRaw) {
      log.error({ idea: idea.id, platform }, "post-drafter produced no usable body");
      return 0;
    }

    const calls = makeVerifierCalls({ force: idea.generationReviewRequired });
    const verifyCtx: VerifyContext = {
      // Explicit per platform. The old `x ? "x" : "linkedin"` else-branch meant a
      // reddit target post would be verified AS LinkedIn, silently opting it into
      // the LinkedIn-only strictVoice rules. No reddit post ideas exist today, so
      // this is latent rather than live — but the next one added would inherit
      // Lyra's voice bar without anyone choosing that.
      platform: platform === "x" ? "x" : platform === "reddit" ? "reddit" : "linkedin",
      postText: [
        "Proposed original-post topic:",
        idea.hook,
        idea.thesis ?? "",
        renderPostFactualContext(ctx),
      ]
        .join("\n")
        .trim(),
      voiceAnchors: ctx.voiceAnchors,
      knowledgeAnchors: boundedPostKnowledgeAnchors(ctx.knowledgeAnchors),
      charLimit: CHAR_LIMIT[platform] ?? POST_CHAR_LIMIT,
    };

    let best = firstRaw;
    let meta: PostVerifierMeta | null = null;

    if (calls.length > 0) {
      const result = await runVerify({
        initial: best,
        basePrompt,
        ctx: verifyCtx,
        calls,
        retries: verifyRetries,
        regenerate: draftOnce,
        log,
        ideaId: idea.id,
      });
      best = result.best;
      meta = result.meta;
    }

    const body = best.body;

    const draft: PostDraftCreate = {
      ideaId: idea.id,
      platform: platform as PostDraftCreate["platform"],
      body,
      // Surface the chosen hook (body's first non-empty line — the prompt forces
      // body to open with it) into its own column so the editor's HOOK field
      // populates and visibly changes on every regen. body is unchanged.
      hook: firstLineHook(body),
      charCount: body.length,
      sourceEngine: best.engine,
      model: best.model,
      qualityScore: meta ? avg(meta.scores) : null,
      qualityPassed: meta ? meta.pass : null,
      verifierMeta: meta,
      generationRequestId: idea.generationRequestId,
      generationComplete: generationComplete === true,
    };
    await sink(draft);
    return 1;
  }

  for (const idea of ideas) {
    // The platforms to (re)draft this tick: a pending subset (a per-platform
    // "+ Version" / regen) or, when none is pending, every target platform.
    const platforms =
      idea.pendingPlatforms && idea.pendingPlatforms.length > 0
        ? idea.pendingPlatforms
        : idea.targetPlatforms;

    // Voice / inspiration / notes are shared across an idea's platform variants,
    // so gather once. A gather failure releases the whole idea for a retry.
    let ctx: PostDraftContext;
    try {
      ctx = await gather(idea);
    } catch (err) {
      log.error(
        { idea: idea.id, err: (err as Error).message },
        "post-drafter gather failed; releasing idea",
      );
      await release(idea.id).catch(() => {});
      continue;
    }

    // A fresh full generate uses the per-platform version counts (3 X + 1 LI);
    // a per-platform "+ Version"/regen (pending subset) adds exactly one.
    const isFreshGenerate = !(idea.pendingPlatforms && idea.pendingPlatforms.length > 0);

    const plannedDrafts = platforms.reduce((sum, platform) => sum + (isFreshGenerate ? (FRESH_VERSIONS[platform] ?? 1) : 1), 0);
    let draftedForIdea = 0;
    let attemptsForIdea = 0;
    for (const platform of platforms) {
      const count = isFreshGenerate ? (FRESH_VERSIONS[platform] ?? 1) : 1;
      for (let v = 0; v < count; v++) {
        attemptsForIdea++;
        // Frame each fresh X variant for a different community so the 3 X posts
        // land distinctly (content-pipeline parity). LinkedIn/Reddit: no framing.
        const community = platform === "x" ? communityForVariant(v) : null;
        try {
          const n = await draftOnePlatform({
            platform,
            idea,
            ctx,
            community,
            generationComplete: Boolean(idea.generationRequestId && attemptsForIdea === plannedDrafts && draftedForIdea + 1 === plannedDrafts),
          });
          if (n) {
            created++;
            draftedForIdea++;
          }
        } catch (err) {
          // One platform/version failing must not lose the others for this idea.
          log.error(
            { idea: idea.id, platform, version: v + 1, err: (err as Error).message },
            "post-drafter platform failed; skipping",
          );
        }
      }
    }

    // Explicit requests retry partial failures too: their final planned output
    // must land before the request can complete. Keep the requested subset.
    if (draftedForIdea === 0 || (idea.generationRequestId && draftedForIdea < plannedDrafts)) {
      await release(idea.id).catch(() => {});
    } else if (args.clearPending) {
      await args.clearPending(idea.id).catch(() => {});
    }
  }

  log.info({ created, candidates: ideas.length }, "post-drafter tick complete");
  return created;
}

function avg(s: { voice: number; grounding: number; relevance: number; format: number }): number {
  return Number(((s.voice + s.grounding + s.relevance + s.format) / 4).toFixed(4));
}

// The chosen hook is body's first non-empty line (the prompt forces body to open
// with it). Extracted for the HOOK field; body is left untouched. Capped so a
// model that ignores the line break doesn't dump the whole post into the field.
function firstLineHook(body: string): string | null {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > 300 ? line.slice(0, 300) : line;
}

type PostAttempt = { body: string; engine: string; model: string };

// Keep the selected body and its generation provenance together through repairs.
async function runVerify(args: {
  initial: PostAttempt;
  basePrompt: string;
  ctx: VerifyContext;
  calls: VerifierCall[];
  retries: number;
  regenerate: (fixPrompt: string) => Promise<PostAttempt | null>;
  log: Logger;
  ideaId: string;
}): Promise<{ best: PostAttempt; meta: PostVerifierMeta }> {
  const { ctx, calls, retries, regenerate, log, ideaId } = args;
  const toDrafts = (body: string): DraftToVerify[] => [{ kind: "post", angle: null, body }];
  const total = (s: { voice: number; grounding: number; relevance: number; format: number }) =>
    s.voice + s.grounding + s.relevance + s.format;

  let best = args.initial;
  let bestVerdict = await verifyTiered(toDrafts(best.body), ctx, calls);
  let attempts = 0;
  while (!bestVerdict.pass && attempts < retries) {
    attempts++;
    const fix = bestVerdict.fix ?? "make the post more specific, grounded, and on-voice";
    const fixPrompt = `${args.basePrompt}\n\nREVIEW FEEDBACK — an editor rejected the previous original post: ${fix}\nRewrite the original post to fix this. Keep the exact strict JSON output shape ({ "body": ... }).`;
    let candidate: PostAttempt | null = null;
    try {
      candidate = await regenerate(fixPrompt);
    } catch (e) {
      log.warn(
        { ideaId, err: (e as Error).message },
        "post verifier regenerate failed; keeping best",
      );
      break;
    }
    if (!candidate) break;
    const verdict = await verifyTiered(toDrafts(candidate.body), ctx, calls);
    if (verdict.pass || total(verdict.scores) > total(bestVerdict.scores)) {
      best = candidate;
      bestVerdict = verdict;
    }
    if (verdict.pass) break;
  }
  log.info(
    { ideaId, pass: bestVerdict.pass, attempts, scores: bestVerdict.scores },
    "post verified",
  );
  return {
    best,
    meta: toOutboundVerifierMeta(bestVerdict, attempts, { requireJudge: false }),
  };
}

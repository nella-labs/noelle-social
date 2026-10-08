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


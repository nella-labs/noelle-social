export * from "./types.js";
export * from "./commitmentGuard.js";
export * from "./notificationTriage.js";
export * from "./notificationWindow.js";
export * from "./conversationBlock.js";
export { resolveObjective, hasCustomObjective } from "./objective.js";
export { stripDisallowedEmoji, applyReplyEmojiPolicy, hasEmoji, ALLOWED_EMOJI } from "./emoji.js";
export { containsExternalLink, stripExternalLinksForPost } from "./linkPolicy.js";
export {
  estimateApifyCents,
  apifySpendRow,
  APIFY_PRICES_CENTS_PER_1K,
  DEFAULT_APIFY_CENTS_PER_1K,
} from "./apifyPrices.js";
export {
  checkApifyAccountUsage,
  type ApifyAccountUsageHealth,
  type ApifyDailyUsage,
  type CheckApifyAccountUsageOptions,
} from "./apifyUsage.js";
export {
  saveApifyUsage,
  type ApifyUsageSaveReason,
  type ApifyUsageSaveResult,
  type SaveApifyUsageOptions,
} from "./apifyUsageDb.js";
export { xApiActionRow } from "./xApiPrices.js";
export {
  assertWithinCap,
  BudgetExceededError,
  type CapAdapters,
  type BudgetAttempt,
  type CapsSnapshot,
  type SpendSnapshot,
} from "./budgetBucket.js";
export { PgOperationError } from "./boundedPgSession.js";
export { isBudgetAdmissionError } from "./budgetAdmissionErrors.js";
export {
  createNellaClient,
  NellaError,
  NellaAuthError,
  type NellaClient,
  type NellaClientOptions,
  type Hit,
  type Anchor,
} from "./nellaClient.js";
export {
  createVaultResolver,
  type VaultResolver,
  type VaultResolverDeps,
  type VaultLookup,
} from "./vaultResolver.js";
export {
  createVaultStorage,
  createGcsStorage,
  type VaultStorage,
  type VaultFileMeta,
  type StorageDeps,
} from "./vaultStorage.js";
export {
  provisionVaultForOrg,
  type ProvisionedVault,
} from "./vaultProvision.js";
export {
  renderVaultTemplate,
  listTemplatePaths,
  type RenderedFile,
  type RenderArgs,
  type VaultWizardStage,
} from "./vaultTemplate.js";
export {
  createGcsNellaClient,
  createGcsNellaClientWithSdk,
  type CreateGcsNellaClientOptions,
  type GcsStorageReader,
} from "./gcsAnchorSource.js";
export {
  createLocalFsKnowledgeBase,
  knowledgeBaseFromNella,
  parseIncludeDirs,
  type KnowledgeBase,
  type KbHit,
  type LocalFsKnowledgeBaseOptions,
  type KbDenseOptions,
  type KbDenseEmbedder,
} from "./knowledgeBase.js";
export {
  createBedrockBackend,
  BedrockProcess,
  BedrockError,
  BedrockAuthError,
  type BedrockBackend,
  type CreateBedrockBackendOptions,
} from "./bedrockBackend.js";
export {
  createAnthropicBackend,
  AnthropicError,
  AnthropicAuthError,
  type AnthropicBackend,
  type CreateAnthropicBackendOptions,
} from "./anthropicBackend.js";
export {
  createClaudeCliBackend,
  CLAUDE_CLI_MODEL,
  resolveClaudeCliModel,
  resolveClaudeCliTarget,
  ClaudeCliError,
  ClaudeCliAuthError,
  type ClaudeCliBackend,
  type CreateClaudeCliBackendOptions,
} from "./claudeCliBackend.js";
export { cliTimeoutMs } from "./cliProcess.js";
export {
  createOpenAiBackend,
  OpenAiError,
  OpenAiAuthError,
  type OpenAiBackend,
  type CreateOpenAiBackendOptions,
} from "./openaiBackend.js";
export {
  buildEngineRegistry,
  type SecretGetter,
  type BuildEngineRegistryOptions,
} from "./engineRegistryFromEnv.js";
export {
  createVertexBackend,
  VertexError,
  VertexAuthError,
  type VertexBackend,
  type VertexAuthClient,
  type CreateVertexBackendOptions,
} from "./vertexBackend.js";
export {
  createGeminiKeyBackend,
  GeminiKeyError,
  GeminiKeyAuthError,
  type GeminiKeyBackend,
  type CreateGeminiKeyBackendOptions,
} from "./geminiKeyBackend.js";
export { parseGeminiGeneration } from "./geminiResponse.js";
export {
  sendPushover,
  PushoverError,
  type PushoverSendArgs,
  type PushoverSendResult,
} from "./pushoverClient.js";
export {
  callAgentModel,
  createBudgetedBackend,
  ModelNotDispatchedError,
  rewriteForClaudeCli,
  EngineNotImplementedError,
  unlimitedBudget,
  type BudgetDeps,
  type CallAgentModelArgs,
  type CallAgentModelDeps,
  type CallAgentModelResult,
  type ChatHistoryTurn,
  type EngineBackend,
  type EngineKey,
  type EngineRegistry,
  type TokenUsage,
} from "./callAgentModel.js";
export {
  makeLlmBackendResolver,
  type LlmBackend,
  type LlmBackendQuery,
  type MakeLlmBackendResolverOptions,
} from "./llmBackendResolver.js";

// Prompt caching (PR-E, theme T7-token-caching) — pure helpers for the opt-in
// Anthropic/Bedrock system-prefix caching. Default OFF (NOELLE_PROMPT_CACHE_*).
// See packages/runtime/src/promptCache.ts + docs/grounded-drafting.md.
export {
  toCachedSystemBlocks,
  resolveCachedSystem,
  shouldCacheSystem,
  effectiveInputTokens,
  isCacheControlError,
  CACHEABLE_SYSTEM_BUCKETS,
  type CacheableTextBlock,
} from "./promptCache.js";

// Scalability primitives — see docs/scalability.md.
export {
  MemoryWorkQueue,
  PgWorkQueue,
  getWorkQueue,
  type PgWorkQueueOptions,
  type WorkQueue,
  type WorkQueueDriver,
  type Claimed,
  type ClaimOptions,
  type EnqueueOptions,
  type NackOptions,
  type GetWorkQueueOptions,
} from "./queue.js";
export {
  MemoryCache,
  CacheBusyError,
  UpstashCache,
  getCache,
  type Cache,
  type CacheDriver,
} from "./cache.js";
export {
  MemoryTokenBucket,
  UpstashTokenBucket,
  getRateLimit,
  enforce,
  rateLimitedResponse,
  _resetRateLimitRegistryForTests,
  type RateLimit,
  type RateLimitDecision,
  type RateLimitDriver,
  type TokenBucketOptions,
  type UpstashTokenBucketOptions,
  type EnforceOptions,
  type EnforceResult,
  type RateLimitedResponse,
} from "./ratelimit.js";

// Tenancy guards — Phase 2 of the Supabase → Cloud SQL migration.
// Used by apps/api-vm routes and apps/app server actions to verify a
// signed-in user belongs to an org before touching `noelle.*` data.
// See packages/runtime/src/tenancy.ts and tasks/supabase-to-gcp-migration.md.
export {
  assertOrgMember,
  isOrgMember,
  OrgMembershipError,
  type OrgMembersQueryClient,
  type QueryExecutor,
} from "./tenancy.js";

// Shared memory bus — a Postgres-backed store any agent/worker writes to and
// reads from at any moment, so every agent knows what is happening org-wide.
// Fail-soft writes; consumes the same QueryExecutor seam as tenancy.
// See packages/runtime/src/bus.ts and docs/shared-memory-bus.md.
export {
  createBus,
  type Bus,
  type BusBucket,
  type BusEmit,
  type BusEventRow,
  type BusPutOptions,
  type BusSeverity,
  type BusStateRow,
  type CreateBusArgs,
} from "./bus.js";

// LLM spend audit — D27 follow-up.
// Shared spend telemetry and budget ownership.
export {
  KNOWN_PRICES,
  estimateCallCents,
  getPrice,
  type Price,
  type EstimateArgs,
  type EngineKey as PriceEngineKey,
} from "./llmPrices.js";
export {
  noopSpendRecorder,
  type SpendRecorder,
  type SpendRow,
  type SpendEngine,
  type SpendStatus,
  type SpendCostBasis,
} from "./spendRecorder.js";

// Model catalog + per-worker routing — feeds the dashboard's per-worker
// model picker and the worker code that needs to know which engine to
// invoke for a given (instance, worker) pair.
export {
  MODEL_CATALOG,
  lookupCatalogEntry,
  catalogWinnerForModel,
  handleForModel,
  effectiveHandle,
  type CatalogEntry,
  type CatalogStatus,
} from "./modelCatalog.js";
export {
  resolveWorkerRouting,
  resolveWorkerRoutingDisplay,
  WORKER_DEFAULTS,
  type PersistedModelOverrides,
} from "./workerRouting.js";

// Grounded-drafting pipeline: the context-assembly distill (gather → 1 brief)
// and the post-draft verifier (judge → regenerate). Both are pure modules —
// the model call is injected by the worker, which owns routing + budget.
export {
  verifyDrafts,
  verifyTiered,
  scoreFormat,
  refineDmVoice,
  replyDiversityScore,
  type DraftToVerify,
  type VerifyContext,
  type DimensionScores,
  type DraftVerdict,
  type VerifierCall,
  type DynamicPattern,
} from "./drafting/draftVerifier.js";
export { toOutboundVerifierMeta } from "./drafting/outboundReview.js";
export {
  JEV_MODEL,
  evaluateJevBoolean,
  evaluateJevBooleans,
  evaluateJevChoice,
  withJevFallbackBoolean,
  type JevBooleanDecision,
  type JevChoiceDecision,
  type JevRun,
} from "./jev.js";
export {
  analyzePatterns,
  refineRule,
  DEFAULT_WINDOWS,
  type PatternPost,
  type PatternAnalyzerCall,
  type AnalyzePatternsArgs,
  type AnalyzedPattern,
  type RefineRuleArgs,
} from "./patternBreaker/analyze.js";
export {
  synthesizeBrief,
  renderBriefBlock,
  hasGatheredContent,
  type GatheredContext,
  type DraftingBrief,
  type SynthesizerCall,
} from "./drafting/contextAssembly.js";
export {
  captionImages,
  createGeminiCaptionFn,
  createVertexCaptionFn,
  createBedrockCaptionFn,
  type CaptionFn,
  type CaptionImagesArgs,
  type VisionAuthClient,
  type BedrockVisionClient,
  type CaptionMetering,
} from "./drafting/visionCaption.js";

export {
  generateImageGemini,
  generateImageVertex,
  type GenerateImageOpts,
  type GenerateImageKeyOpts,
  type ImageAuthClient,
} from "./drafting/imageGen.js";

// Bounded-concurrency fan-out — the repo's first concurrency primitive.
// `Promise.allSettled`-style isolation with a hand-rolled, order-preserving
// worker pool. First consumer: the Account Feeder's parallel Gemini extractors.
// See packages/runtime/src/batchMap.ts and the Account Feeder design doc §2.13.
export {
  batchMap,
  type BatchResult,
  type BatchMapOptions,
} from "./batchMap.js";

// Account Feeder (F4a) — Voyage rerank-2.5 style-exemplar ranking. Fail-open:
// returns input order when VOYAGE_API_KEY is unset or the call fails/times out.
// See packages/runtime/src/voyageRerank.ts and the feeder spec §7 F4a.
export {
  voyageRerank,
  rankStyleExemplars,
  type RerankResult,
  type VoyageRerankOptions,
  type RankStyleExemplarsOptions,
} from "./voyageRerank.js";

// Account Feeder (F4b) — phase-2 DENSE layer: Voyage `voyage-3-large`
// embeddings (1024d) + Reciprocal Rank Fusion of the dense cosine ranking with
// the F4a rerank. Dormant until the corpus is embedded (migration 0052 +
// backfill) and `NOELLE_DRAFTER_DENSE` (read by F6) is ON. Fails open at every
// step to the F4a rerank-only path, then to input order.
// See packages/runtime/src/{voyageEmbed,rrf,hybridRank}.ts and the feeder spec §7 F4b.
export {
  voyageEmbed,
  type VoyageEmbedOptions,
} from "./voyageEmbed.js";
export {
  rrfFuse,
  cosineSim,
} from "./rrf.js";
export {
  hybridRankStyleExemplars,
  type HybridRankOptions,
} from "./hybridRank.js";

// KnowledgeBase HYBRID DENSE lane — Voyage `voyage-context-4` CONTEXTUALIZED
// chunk embeddings, fused with BM25 (RRF) inside `createLocalFsKnowledgeBase`.
// Shared by every agent via one factory; opt-in with `NOELLE_KB_DENSE=1`.
// Fail-open to pure BM25. See knowledgeBase.ts + docs/grounded-drafting.md.
export {
  voyageContextEmbed,
  voyageContextEmbedQuery,
  type VoyageContextEmbedOptions,
} from "./voyageContextEmbed.js";
export {
  buildDenseIndex,
  type DenseIndex,
  type DenseResult,
} from "./denseChunkIndex.js";

// Content ingestion bridge — HMAC sign + POST the post-ideas/post-drafts wire
// contract into noelle.* (the prod-scalable replacement for content-pipeline's
// local-JSON store). Shared by the server workers and the `noelle content push`
// operator/skills path. Also exposed at "@noelle/runtime/content-push" for
// lean, backend-free imports.
export {
  signContentRequest,
  pushPostIdeas,
  pushPostDraft,
  type SignedHeaders,
  type ContentPlatform,
  type PushInspirationRef,
  type PushPostIdea,
  type PushPostDraft,
  type PushClientOpts,
} from "./contentPush.js";

// Pinned style source — pure name→handle resolution + chat-directive extraction
// for the "write in this exact person's style" lever. Shared by api-vm (chat
// resolution) and the intern workers. No DB / LLM deps.
export {
  normalizeStyleName,
  resolveStyleSourceHandle,
  extractStyleDirective,
  readPinnedHandle,
  readStyleExemplarKinds,
  readFaithfulVoices,
  readFaithfulVoiceWeights,
  pickFaithfulVoice,
  pinnedSelectConfig,
  PIN_MIN_EXEMPLARS,
  type StyleSourceRef,
} from "./stylePin.js";

// Account Feeder — the platform-agnostic style selector, the STYLE-block renderer,
// the per-draft style-source attribution, and the corpus row / post-register types.
// Shared by both interns (Lyra/LinkedIn, Vega/X) so there is ONE implementation,
// not hand-mirrored copies. See packages/runtime/src/style{Select,Block,Types}.ts.
export {
  selectStyleExemplars,
  styleCheer01,
  makeSeededRng,
  type StyleExemplar,
  type StyleSelection,
  type SelectStyleOptions,
} from "./styleSelect.js";
export {
  renderStyleBlock,
  buildStyleSource,
  type StyleForPrompt,
  type StyleExemplarForPrompt,
} from "./styleBlock.js";
export { DM_RUNGS, pickRung, type DmRung } from "./dmLadder.js";
export {
  countSentDmsToAuthor,
  getRecentDmsToAuthor,
  type DmAuthorArgs,
  type RecentDmsArgs,
} from "./dmLadderDb.js";
export { loadVoiceSpec, voiceSpecBlock } from "./voiceSpec.js";
export { upsertPlaybook, getFreshPlaybookAuthors, type PlaybookUpsert } from "./playbooksDb.js";
export {
  shardRoundRobin,
  splitBudget,
  shardStaggerDelayMs,
  runWithConcurrency,
} from "./shard.js";
export {
  qualifyByHeadline,
  qualifyByProfileText,
  icpGateConfigured,
  type IcpHeadlineGate,
  type IcpGateResult,
} from "./icpGate.js";
export {
  OPENING_MOVES,
  X_OPENING_MOVES,
  pickOpeningMove,
  renderOpeningMoveBlock,
  type OpeningMove,
} from "./openingMove.js";
export {
  getRecentRepliesToAuthor,
  getRecentReplyPhrasings,
  type PriorRepliesArgs,
  type RecentPhrasingsArgs,
} from "./priorReplies.js";
export {
  FORM_VARIANTS,
  X_FORM_VARIANTS,
  REDDIT_FORM_VARIANTS,
  LIGHT_EXCLUDED_VARIANT_IDS,
  SHAPES_WITH_FREE_OPENER,
  SHAPES_BANNING_QUESTIONS,
  STANCE_SHAPE_IDS,
  DEFAULT_ROTATION_MEMORY,
  TONE_FIRST_ENERGIES,
  ENERGY_SHAPE_IDS,
  TONE_FIRST_SHAPE_SHARE,
  shapesForEnergy,
  shapesExcludedForEnergy,
  pickFormVariant,
  createFormVariantRotation,
  renderAssignedShapeBlock,
  type FormVariant,
  type FormVariantForPrompt,
} from "./formVariants.js";
export {
  humanizeTypos,
  pickTypoKind,
  typoRateFromEnv,
  TYPO_VARIANTS,
  DEFAULT_TYPO_RATE,
  type TypoKind,
  type TypoVariant,
  type HumanizeOptions,
  type HumanizeResult,
} from "./humanTypos.js";
export {
  GENZ_MARKERS,
  DEFAULT_MARKER_RATE,
  LOUD_BLOCKED_ENERGIES,
  markersForEnergy,
  pickGenZMarker,
  renderGenZMarkerBlock,
  createGenZMarkerRotation,
  genzMarkerRateFromEnv,
  type GenZMarker,
  type MarkerTier,
  type MarkerPoolOpts,
} from "./genzMarkers.js";
export { NO_HOUSE_SKELETON_RULE, houseSkeletonHits } from "./houseSkeleton.js";
export {
  polishReplyBody,
  NO_PERIODS_RULE,
  PLATFORM_CHAR_CAP,
  type PolishResult,
  type PolishOptions,
} from "./replyPolish.js";
export type { StyleExemplarRow, UltraProfileRow, PostRegister } from "./styleTypes.js";

// Content media storage — one interface (put/delete), local-disk (self-host)
// and GCS (prod) backends. Exposed at "@noelle/runtime/content-storage".
export {
  assertSafeKey,
  extForMime,
  mediaKey,
  createLocalContentStorage,
  createGcsContentStorage,
  type ContentStorage,
  type GcsContentOps,
} from "./contentStorage.js";

// Recurring scheduled run (0085_run_schedule.sql) — next-fire math + fire/skip
// decision. Shared by the api-vm scheduler and the setRunSchedule save action.
export {
  computeNextRunAt,
  planScheduledRun,
  type ScheduledRunRow,
  type ScheduledRunPlan,
} from "./runSchedule.js";

export {
  notifyBudgetBlockedOnce,
  type BudgetAlertDeps,
  type BudgetAlertResult,
} from "./budgetAlert.js";

export {
  createCodexCliBackend,
  parseCodexUsage,
  CODEX_CLI_MODEL,
  CodexCliError,
  CodexCliAuthError,
  type CreateCodexCliBackendOptions,
} from "./codexCliBackend.js";

export { parseCodexError } from "./codexCliBackend.js";

export {
  getVoiceExemplars,
  type VoiceExemplar,
  type VoiceExemplarsArgs,
} from "./priorReplies.js";

export {
  getRepliedPostSources,
  type RepliedPostSource,
  type RepliedPostSourcesArgs,
} from "./ideationSources.js";

export { renderVoiceExemplars } from "./voiceExemplars.js";

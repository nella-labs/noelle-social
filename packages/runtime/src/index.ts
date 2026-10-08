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

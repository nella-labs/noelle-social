import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createClaudeCliBackend,
  CLAUDE_CLI_MODEL,
  OrgMembershipError,
  type EngineBackend,
  type CreateClaudeCliBackendOptions,
} from "@noelle/runtime";
import { tryGetChatProfile } from "@noelle/agents/chat";
import {
  getAgentInstance,
  loadLatestChatConversation,
  loadChatTurnsForModel,
  appendChatTurn,
} from "@/lib/queries";
import { channelForRole } from "@/lib/social-channels";
import { loadChatContextForInstance } from "@/lib/agent-chat/context";
import { bindVaultEdit, publicVaultEditReceipt, extractProposal, extractVaultEdit, extractScriptEdit } from "@/lib/agent-chat/proposal";
import type { VaultSnapshot } from "@/lib/vault-snapshot";
import { BedrockInitError, loadBedrockBackend, serializeError } from "@/lib/agent-chat/bedrock-backend";
import type { NoelleAgentInstance } from "@/lib/db-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/agents/[instanceId]/chat
 *
 * Bedrock-backed talk-to-agent panel on the per-agent detail page.
 * The system prompt is composed of two halves:
 *
 *   1. Persona + job + voice    — declared per role in `@noelle/agents/chat`
 *                                 (see docs/agent-model.md §3.x). Static.
 *   2. Live snapshot            — loaded here per turn from `noelle.*`
 *                                 (pending approvals, worker freshness,
 *                                  org rollup). See lib/agent-chat/context.ts.
 *
 * Conversations are persisted (noelle.agent_chat_messages, migration 0064):
 * one rolling thread per (user, instance). Each POST loads the prior turns of
 * the active conversation, feeds them to the model as history, and appends the
 * new user+agent turn — so the chat survives reloads and the model has memory.
 * The live snapshot is still rebuilt every turn (that's the part that must be
 * fresh); the persisted log is layered on top of it as conversation history.
 *
 * GET /api/agents/[instanceId]/chat returns the role's greeting + suggestion
 * chips for the first paint AND the operator's most recent conversation
 * (conversationId + messages) so the panel resumes where they left off.
 *
 * Auth: getAgentInstance() enforces org membership before returning the
 * row (throws OrgMembershipError otherwise). Per-user rate-limit is
 * enforced by middleware.ts at 120 capacity / 1 token-per-second.
 *
 * Routing: Bedrock Claude Sonnet 4.6 (us cross-region inference profile).
 * Keys come from the process env on self-host (NOELLE_SECRETS_SOURCE=env, same
 * as the worker pool) or GCP Secret Manager on the managed box
 * (noelle-worker-bedrock-aws-{access-key-id,secret-access-key}); the backend
 * instance is memoised on globalThis to survive HMR + warm boots.
 *
 * Limits: model max_tokens=512 (chat answers are short by design) to keep
 * per-turn cost ≈ $0.005 even on long prompts.
 */

const BodySchema = z.object({
  message: z.string().min(1).max(4_000),
  /**
   * The conversation this turn belongs to. Omitted/null on the first message of
   * a thread (and after "New chat") — the server then mints a fresh id and
   * returns it so the client threads subsequent turns onto it.
   */
  conversationId: z.string().uuid().nullish(),
  /**
   * Video intern (Nova) only: the draft the founder is refining in the studio.
   * When present the server loads that draft into the chat context so Nova
   * grounds its answers in the exact video on screen. Ignored for other roles.
   */
  draftId: z.string().uuid().nullish(),
});

declare global {
  var __noelleClaudeCliChatBackend: EngineBackend | undefined;
}

/**
 * The model label shown to the operator + recorded — the strongest path
 * available. On a VM with `NOELLE_CLAUDE_CLI=1` the chat runs through local
 * `claude -p` (a Claude Max sub, ~$0/call, strongest model), so we surface that
 * instead of the Bedrock Sonnet fallback.
 */
function chatModelLabel(modelOverrides: unknown): string {
  if (process.env.NOELLE_CLAUDE_CLI === "1") {
    // Read the backend's own constant so the recorded/displayed label is
    // exactly the model the CLI ran (this used to re-derive the default and
    // drifted — it reported plain `claude-opus-4-8` for a `[1m]` call).
    return CLAUDE_CLI_MODEL;
  }
  return resolveChatModel(modelOverrides);
}

/**
 * Pick the chat backend: prefer the local Claude CLI (`claude -p`, strongest
 * model, free on a Max sub) when wired on this VM; otherwise the shared Bedrock
 * backend. Returns the model label to record + display alongside.
 */
async function loadChatBackend(
  modelOverrides: unknown,
): Promise<{ backend: EngineBackend; model: string; viaClaudeCli: boolean }> {
  if (process.env.NOELLE_CLAUDE_CLI === "1") {
    if (!globalThis.__noelleClaudeCliChatBackend) {
      const cliOpts: CreateClaudeCliBackendOptions = {};
      if (process.env.NOELLE_CLAUDE_CLI_PATH) cliOpts.cliPath = process.env.NOELLE_CLAUDE_CLI_PATH;
      if (process.env.NOELLE_CLAUDE_CLI_TIMEOUT_MS) cliOpts.timeoutMs = Number(process.env.NOELLE_CLAUDE_CLI_TIMEOUT_MS);
      globalThis.__noelleClaudeCliChatBackend = createClaudeCliBackend(cliOpts);
    }
    return { backend: globalThis.__noelleClaudeCliChatBackend, model: chatModelLabel(modelOverrides), viaClaudeCli: true };
  }
  return { backend: await loadBedrockBackend(CHAT_MAX_TOKENS), model: resolveChatModel(modelOverrides), viaClaudeCli: false };
}

const CHAT_MAX_TOKENS = 512;
const DEFAULT_CHAT_MODEL = "claude-sonnet-4-6";
const ALLOWED_CHAT_MODELS = new Set([
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
]);

/**
 * Resolve which Bedrock model to call from the agent's persisted
 * `model_overrides`. Mirrors `xInternRouting()` in the worker — same
 * validation, same default fallback. Vertex / non-Bedrock overrides are
 * ignored (no backend yet) and the chat falls back to Sonnet.
 */
function resolveChatModel(modelOverrides: unknown): string {
  if (!modelOverrides || typeof modelOverrides !== "object") return DEFAULT_CHAT_MODEL;
  const primary = (modelOverrides as { primary?: unknown }).primary;
  if (!primary || typeof primary !== "object") return DEFAULT_CHAT_MODEL;
  const { engine, model } = primary as { engine?: unknown; model?: unknown };
  if (engine !== "bedrock") return DEFAULT_CHAT_MODEL;
  if (typeof model !== "string" || !ALLOWED_CHAT_MODELS.has(model)) {
    return DEFAULT_CHAT_MODEL;
  }
  return model;
}

/**
 * First-paint greeting when the Nova chat is opened from a draft's "Refine"
 * button — names the video and offers refine-shaped chips so it reads as
 * draft-aware before the first turn. The real grounding (beats, script,
 * visuals) is injected into the system prompt on POST.
 */
function videoRefineGreeting(
  displayName: string,
  hook: string,
): { body: string; suggestions: string[] } {
  const shortHook = hook.length > 90 ? `${hook.slice(0, 90)}…` : hook;
  return {
    body:
      `Let's sharpen this one — "${shortHook}". I've got its hook, beats, script, and on-screen visuals in front of me. ` +
      `Tell me what feels off, or pick a starting point below.`,
    suggestions: [
      "Tighten the hook",
      "Punch up the CTA",
      "Is the pacing right?",
      "Cut a beat — which is weakest?",
      "Rewrite this in my voice",
    ],
  };
}

function displayNameFor(instance: NoelleAgentInstance): string {
  return instance.display_name ?? channelForRole(instance.role)?.label ?? "Channel";
}

/**
 * Fallback prompt used when a role has no registered chat profile.
 * Loud-failure path: keeps the chat answering instead of 500ing, but the
 * persona will be obviously generic so the regression shows up in QA.
 */
function fallbackSystemPrompt(displayName: string, role: string): string {
  return [
    `You are "${displayName}", a social writing partner in Noelle (role: ${role}).`,
    "You have no chat profile registered yet — answer briefly, do not fabricate specifics about the org, and tell the founder a chat profile needs to be added for this role.",
    "Talk like a thoughtful colleague, not a chatbot. Short paragraphs.",
  ].join("\n\n");
}

async function buildSystemPrompt(
  instance: NoelleAgentInstance,
  draftId?: string | null,
): Promise<string> {
  const displayName = displayNameFor(instance);
  const profile = tryGetChatProfile(instance.role);
  if (!profile) return fallbackSystemPrompt(displayName, instance.role);
  const context: Awaited<ReturnType<typeof loadChatContextForInstance>> = await loadChatContextForInstance(instance, { draftId }).catch((err) => {
    console.warn("[chat] context load failed, falling back to persona-only", err);
    return {};
  });
  return profile.systemPrompt({ displayName, context });
}

async function resolveInstance(
  instanceId: string,
): Promise<
  | { kind: "ok"; instance: NoelleAgentInstance }
  | { kind: "forbidden" }
  | { kind: "not_found" }
> {
  try {
    const instance = await getAgentInstance(instanceId);
    if (!instance) return { kind: "not_found" };
    return { kind: "ok", instance };
  } catch (err) {
    if (err instanceof OrgMembershipError) return { kind: "forbidden" };
    throw err;
  }
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ instanceId: string }> },
): Promise<NextResponse> {
  const { instanceId } = await ctx.params;
  const draftId = new URL(req.url).searchParams.get("draftId");
  const resolved = await resolveInstance(instanceId);
  if (resolved.kind === "forbidden") {
    return NextResponse.json(
      { error: "forbidden", message: "Not a member of this org." },
      { status: 403 },
    );
  }
  if (resolved.kind === "not_found") {
    return NextResponse.json(
      { error: "not_found", message: "Agent instance not found." },
      { status: 404 },
    );
  }
  const { instance } = resolved;
  const displayName = displayNameFor(instance);
  const profile = tryGetChatProfile(instance.role);

  // Resume the operator's most recent thread for this instance. Fail-open: a
  // history read error must not block the greeting (the chat still works, it
  // just starts fresh).
  const conversation = await loadLatestChatConversation(instanceId).catch(
    (err) => {
      console.warn("[chat] history load failed:", err);
      return { conversationId: null, messages: [] as never[] };
    },
  );

  let greeting = profile
    ? profile.greeting({ displayName })
    : {
        body: `Hi — I'm ${displayName}. Ask me anything about my work.`,
        suggestions: ["What are you working on?", "What do you need from me?"],
      };

  // Refine mode: the chat was opened from a specific draft. Make the first paint
  // name the video and offer refine-shaped chips, so it's obvious Nova knows
  // what we're working on. Fail-open: any load issue keeps the generic greeting.
  if (draftId && instance.role === "video_intern") {
    const ctxSnap = await loadChatContextForInstance(instance, { draftId }).catch(
      () => ({} as Awaited<ReturnType<typeof loadChatContextForInstance>>),
    );
    if (ctxSnap.currentDraft) {
      greeting = videoRefineGreeting(displayName, ctxSnap.currentDraft.hook);
    }
  }

  return NextResponse.json({
    greeting,
    conversationId: conversation.conversationId,
    messages: conversation.messages,
    model: chatModelLabel(instance.model_overrides),
  });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ instanceId: string }> },
): Promise<NextResponse> {
  const { instanceId } = await ctx.params;

  let body: z.infer<typeof BodySchema>;
  try {
    const raw = await req.json();
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_body", message: parsed.error.message },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const resolved = await resolveInstance(instanceId);
  if (resolved.kind === "forbidden") {
    return NextResponse.json(
      { error: "forbidden", message: "Not a member of this org." },
      { status: 403 },
    );
  }
  if (resolved.kind === "not_found") {
    return NextResponse.json(
      { error: "not_found", message: "Agent instance not found." },
      { status: 404 },
    );
  }
  const { instance } = resolved;

  const vaultSnapshot: VaultSnapshot = { digest: null, bases: {}, refreshReasons: {}, byteAllowance: 0 };
  const system = await buildSystemPrompt(instance, body.draftId);

  let backend: EngineBackend;
  let chatModel: string;
  let viaClaudeCli = false;
  try {
    const picked = await loadChatBackend(instance.model_overrides);
    backend = picked.backend;
    chatModel = picked.model;
    viaClaudeCli = picked.viaClaudeCli;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Bedrock init failed";
    const stage = err instanceof BedrockInitError ? err.stage : "unknown";
    // Stringify the error structure: Vercel runtime logs swallow nested
    // Error objects passed as the second console.error arg, so without
    // JSON.stringify the cause never makes it to the dashboard.
    console.error(
      `[chat] bedrock init failed stage=${stage} ${JSON.stringify(
        serializeError(err),
      )}`,
    );
    return NextResponse.json(
      { error: "model_unavailable", stage, message: msg },
      { status: 503 },
    );
  }

  // Thread this turn onto the active conversation, or start a fresh one. We
  // need the id before the model call so we can both load prior turns and
  // persist under it afterward.
  const conversationId = body.conversationId ?? crypto.randomUUID();

  // Prior turns of this conversation become the model's history. Fail-open: if
  // the read errors we still answer, just without memory of earlier turns.
  const history = body.conversationId
    ? await loadChatTurnsForModel(instanceId, body.conversationId).catch(
        (err) => {
          console.warn("[chat] history-for-model load failed:", err);
          return [] as Awaited<ReturnType<typeof loadChatTurnsForModel>>;
        },
      )
    : [];

  try {
    let res;
    try {
      res = await backend.call({ system, prompt: body.message, model: chatModel, history });
    } catch (callErr) {
      if (!viaClaudeCli) throw callErr;
      // `claude -p` failed (binary missing / not logged in) — fall back to
      // Bedrock so the chat still answers instead of breaking.
      console.warn("[chat] claude-cli call failed, falling back to bedrock:", callErr);
      const bedrock = await loadBedrockBackend();
      chatModel = resolveChatModel(instance.model_overrides);
      res = await bedrock.call({ system, prompt: body.message, model: chatModel, history });
    }
    // The model may append a fenced `noelle-proposal` block when the founder
    // asked to change targeting/mission. Pull it out + validate it; the block
    // is stripped from the text either way so the founder never sees raw JSON.
    // The proposal only becomes a DB write when the client hits Apply (which
    // replays it through the applyTargetingChange server action).
    // Two propose-then-confirm channels share the reply: a targeting/mission
    // proposal and (Head of Growth) a vault edit. Extract both — each strips its
    // own fenced block, so the displayed text has neither.
    const p = extractProposal(res.text);
    const v = extractVaultEdit(p.text);
    // Nova's video refiner may also append a script-edit block. Extract it last
    // so its fenced block is stripped from the displayed text too.
    const sc = extractScriptEdit(v.text);
    const storedVaultEdit = v.vaultEdit ? bindVaultEdit(v.vaultEdit, vaultSnapshot, instance.role) : null;

    // Persist the completed turn (user message + cleaned agent reply). The
    // displayed/stored text has the fenced blocks stripped; the proposal +
    // vault edit ride along as jsonb so the transcript re-renders their cards
    // on resume. The script edit is live-only (no column) — it's actioned in
    // the studio this session, not replayed on reload. Fail-open: a write error
    // must not lose the answer the user already has — log and still return.
    const messageId = await appendChatTurn({
      instanceId,
      conversationId,
      userBody: body.message,
      agentBody: sc.text,

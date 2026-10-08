"use client";

import * as React from "react";
import type { TargetingProposal, VaultEditProposal, ScriptEditProposal } from "@noelle/contracts";
import { TargetingProposalSchema, targetingProposalMatchesRole } from "@noelle/contracts";
import { Avatar, type AvatarRole } from "@/components/constellation/Avatar";
import { chatErrorMessage } from "@/components/agent-panels/chat-error-message";
import { useChatSession } from "./use-chat-session";
import { applyTargetingChange, type ApplyTargetingResult } from "@/lib/agent-targeting";
import { applyVaultEdit } from "@/lib/agent-vault";
import type { VaultEditClientReceipt } from "@/lib/agent-chat/proposal";
import { parseMessageSegments } from "@/lib/chat-markdown";

interface AgentChatProps {
  /** Stable slot id used for the offline greeting fallback (the social channel setup slug). */
  agentId: string;
  /** Avatar role. */
  agentRole: string;
  /** Display name from the channel instance. */
  agentName: string;
  /**
   * DB UUID for the agent instance. When present, the chat hits the real
   * Bedrock-backed route. When absent (roster-placeholder pages), the chat
   * renders disabled with a "no instance yet" notice — no LLM call.
   */
  instanceId?: string;
  /**
   * Org slug — needed to apply a targeting/mission proposal (the Apply button
   * calls the applyTargetingChange server action, which is org-scoped).
   */
  orgSlug?: string;
  userInitial?: string;
  userName?: string;
  /**
   * Video intern (Nova) only: the draft the founder is refining. Sent with every
   * GET/POST so the server grounds the chat in that exact video. When it changes
   * (the founder switches drafts) the greeting refetches for the new one.
   */
  draftId?: string;
  /**
   * Let the transcript grow to fill the parent instead of the default fixed
   * 380px cap. The parent must give this component a bounded height (e.g. a
   * flex/grid cell or an explicit height) — the message list then flexes to
   * fill it and the composer pins to the bottom. Used by the studio's right
   * pane so the chat fills the column instead of floating in dead space.
   */
  fillHeight?: boolean;
  /**
   * Nova (video refiner) only: apply a proposed script edit to the studio
   * editor. Called when the founder clicks Apply on a script-edit card; the
   * parent loads the new lines into the editor (marked dirty) for review + Save.
   */
  onApplyScriptEdit?: (edit: ScriptEditProposal) => boolean;
}

type ProposalState = "pending" | "applied" | "cancelled";

/**
 * Render a message body with clickable links. Markdown links and bare
 * http(s) URLs (e.g. the X reply links Vega surfaces) become real anchors;
 * everything else stays plain text. The container keeps `white-space:
 * pre-wrap`, so newlines inside text segments are preserved.
 */
function renderInline(text: string): React.ReactNode {
  // Inline **bold** segments, then links inside each run. XSS-safe (no HTML).
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      return <strong key={i}>{renderLinks(part.slice(2, -2))}</strong>;
    }
    return <React.Fragment key={i}>{renderLinks(part)}</React.Fragment>;
  });
}

function renderLinks(text: string): React.ReactNode {
  return parseMessageSegments(text).map((seg, i) =>
    seg.type === "link" ? (
      <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", textDecoration: "underline" }}>
        {seg.label}
      </a>
    ) : (
      <React.Fragment key={i}>{seg.value}</React.Fragment>
    ),
  );
}

/**
 * Light block-level markdown for agent replies: blockquotes (`> …`), bullet
 * lists (`- ` / `* `), and paragraphs, with inline **bold** + links. Keeps the
 * model's structured rewrites readable instead of showing raw `>`/`**`.
 */
function renderMessageBody(text: string): React.ReactNode {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      blocks.push(
        <div key={key++} style={{ borderLeft: "2px solid color-mix(in oklch, var(--accent) 45%, var(--rule))", padding: "2px 0 2px 10px", margin: "4px 0", color: "var(--ink)", fontStyle: "italic" }}>
          {renderInline(quote.join("\n"))}
        </div>,
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
      blocks.push(
        <ul key={key++} style={{ margin: "4px 0", paddingLeft: 18 }}>
          {items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}
        </ul>,
      );
      continue;
    }
    // Gather a paragraph (consecutive non-blank, non-quote, non-list lines).
    if (line.trim() === "") { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^\s*>\s?/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) { para.push(lines[i]); i++; }
    blocks.push(<div key={key++} style={{ margin: blocks.length ? "4px 0 0" : 0 }}>{renderInline(para.join("\n"))}</div>);
  }
  return blocks;
}

interface ChatMessage {
  who: "agent" | "user";
  at: string;
  body: string;
  suggestions?: string[];
  /** A targeting/mission change the agent proposed this turn (propose-then-confirm). */
  proposal?: TargetingProposal | null;
  /** Lifecycle of the attached proposal. */
  proposalState?: ProposalState;
  /** A vault edit the Head of Growth proposed this turn (propose-then-confirm). */
  vaultEdit?: VaultEditProposal | null;
  vaultEditReceipt?: VaultEditClientReceipt | null;
  /** Lifecycle of the attached vault edit. */
  vaultEditState?: ProposalState;
  /** A script edit Nova proposed this turn (propose-then-confirm). */
  scriptEdit?: ScriptEditProposal | null;
  /** Lifecycle of the attached script edit. */
  scriptEditState?: ProposalState;
}

interface GreetingPayload {
  body: string;
  suggestions: string[];
}

/** A persisted turn returned by GET, shaped for the transcript. */
interface HistoryMessage {
  who: "agent" | "user";
  at: string;
  body: string;
  vaultEdit?: VaultEditProposal | null;
  vaultEditReceipt?: VaultEditClientReceipt | null;
}

/** Shape of the GET /chat response (greeting + the resumed conversation). */
interface ChatGetPayload {
  greeting?: GreetingPayload;
  conversationId?: string | null;
  messages?: HistoryMessage[];
  model?: string;
}

/** Build the GET /chat URL, attaching ?draftId when refining a specific draft. */
function chatGetUrl(instanceId: string, draftId?: string): string {
  const base = `/api/agents/${encodeURIComponent(instanceId)}/chat`;
  return draftId ? `${base}?draftId=${encodeURIComponent(draftId)}` : base;
}

/** Pretty-print a model id for the footer: "claude-opus-5[1m]" → "opus 5". */
function prettyModel(model: string | null): string {
  if (!model) return "model pending";
  return model
    .replace(/^claude-/, "")
    .replace(/\[.*\]$/, "")
    .replace(/^([a-z]+)-/, "$1 ")
    .replace(/-/g, ".")
    .trim();
}

/**
 * AgentChat — context-aware chat on the per-agent detail page.
 *
 * Wired to `POST /api/agents/[instanceId]/chat` with the configured chat model.
 * The system prompt is composed server-side from the agent's chat profile
 * in `@noelle/agents/chat` plus a live snapshot of pending approvals + worker
 * freshness — see route.ts. The server loads the current conversation history.
 *
 * The greeting + suggestion chips are also pulled from the server profile
 * (GET on the same route) so the panel and the system prompt stay in sync.
 * When `instanceId` is absent (roster placeholder route), the textarea +
 * send button are disabled and we show a tiny offline-greeting fallback
 * keyed by `agentId` instead of mocking responses.
 */
export function AgentChat(props: AgentChatProps) {
  const identity = JSON.stringify([props.orgSlug, props.instanceId, props.draftId, props.agentId]);
  return <AgentChatSession key={identity} {...props} />;
}

function AgentChatSession({
  agentId,
  agentRole,
  agentName,
  instanceId,
  orgSlug,
  userInitial = "Y",
  userName = "You",
  draftId,
  fillHeight = false,
  onApplyScriptEdit,
}: AgentChatProps) {
  const { beginRequest, beginAction, isCurrent, finish, invalidate } = useChatSession();
  const conversationStarted = React.useRef(false);
  const fallback = React.useMemo(
    () => offlineGreeting(agentId, agentName),
    [agentId, agentName],
  );
  const [chat, setChat] = React.useState<ChatMessage[]>([
    { who: "agent", at: "just now", body: fallback.body, suggestions: fallback.suggestions },
  ]);
  const [draft, setDraft] = React.useState("");
  const [thinking, setThinking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  /**
   * The last request and its explicit file refresh, kept so the inline "Retry"
   * button can resend without making the user retype. Cleared on
   * any successful response.
   */
  const [lastSent, setLastSent] = React.useState<{ message: string; vaultPath?: string } | null>(null);
  /**
   * The persisted conversation this chat is threaded onto. Null until the
   * first turn of a fresh thread is sent (the server mints the id and returns
   * it) or until a prior thread is resumed on mount. "New chat" resets it to
   * null so the next message starts a new thread.
   */
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  /** The model actually answering (from the server) — shown in the footer. */
  const [model, setModel] = React.useState<string | null>(null);
  /** Index of the chat message whose proposal is currently being applied. */
  const [applyingIdx, setApplyingIdx] = React.useState<number | null>(null);
  /** Index of the chat message whose vault edit is currently being applied. */
  const [applyingVaultIdx, setApplyingVaultIdx] = React.useState<number | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const busy = thinking || applyingIdx !== null || applyingVaultIdx !== null;
  const canSend = !!instanceId && !busy;

  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chat, thinking]);

  const loadGreeting = React.useCallback(async (resume: boolean) => {
    if (!instanceId) return;
    const operation = beginRequest();
    try {
      const res = await fetch(chatGetUrl(instanceId, draftId), { method: "GET", signal: operation.controller.signal });
      if (!res.ok) return;
      const payload = (await res.json()) as ChatGetPayload;
      if (!isCurrent(operation) || conversationStarted.current) return;
      if (payload.model) setModel(payload.model);

      const history = payload.messages ?? [];
      if (resume && history.length > 0) {
        // Vault receipts remain reviewable; Apply checks current file bytes before replacement.
        setConversationId(payload.conversationId ?? null);
        setChat((c) => {
          // Don't clobber a message the user already started this session.
          if (c.length !== 1 || c[0]?.who !== "agent") return c;
          return history.map((m) => ({ who: m.who, at: m.at, body: m.body, vaultEdit: m.vaultEdit, vaultEditReceipt: m.vaultEditReceipt }));
        });
        return;
      }

      if (!payload.greeting) return;
      setChat((c) => {
        // Only replace if the user hasn't typed yet — once a conversation
        // starts we don't yank the seed message out from under them.
        if (c.length !== 1 || c[0]?.who !== "agent") return c;
        return [
          {
            who: "agent",
            at: "just now",
            body: payload.greeting!.body,
            suggestions: payload.greeting!.suggestions,
          },
        ];
      });
    } catch (err) {
      if (isCurrent(operation)) console.warn("[agent-chat] greeting fetch failed:", err);
    } finally {
      finish(operation);
    }
  }, [instanceId, draftId, beginRequest, isCurrent, finish]);

  React.useEffect(() => { void loadGreeting(true); }, [loadGreeting]);

  const send = async (text: string, opts: { isRetry?: boolean; vaultPath?: string } = {}) => {
    const trimmed = text.trim();
    if (!trimmed || !instanceId) return;
    const operation = beginAction();
    if (!operation) return;
    conversationStarted.current = true;
    // On a retry we already have the user-side message in the transcript
    // (it was added on the original failed attempt); appending it a second
    // time would visually duplicate the question.
    if (!opts.isRetry) {
      setChat((c) => [...c, { who: "user", at: "now", body: trimmed }]);
      setDraft("");
    }
    setLastSent({ message: trimmed, vaultPath: opts.vaultPath });
    setError(null);
    setThinking(true);

    try {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(instanceId)}/chat`,
        {
          method: "POST",
          signal: operation.controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: trimmed, conversationId, draftId, vaultPath: opts.vaultPath }),
        },
      );
      if (!res.ok) {
        const payload = await safeJson(res);
        if (!isCurrent(operation)) return;
        const detail = payload?.message ?? `HTTP ${res.status}`;
        console.error(
          "[agent-chat] upstream error:",
          res.status,
          payload?.error,
          detail,
        );
        const msg = chatErrorMessage({
          status: res.status,
          code: payload?.error,
          agentName,
        });
        setError(msg);
        setChat((c) => [
          ...c,
          { who: "agent", at: "just now", body: msg },
        ]);
        return;
      }
      const payload = (await res.json()) as {
        text?: string;
        proposal?: TargetingProposal | null;
        vaultEdit?: VaultEditProposal | null;
        vaultEditReceipt?: VaultEditClientReceipt | null;
        scriptEdit?: ScriptEditProposal | null;
        conversationId?: string;
        model?: string;
      };
      if (!isCurrent(operation)) return;
      const reply = payload.text?.trim() || "(no response)";
      const parsedProposal = TargetingProposalSchema.safeParse(payload.proposal);
      const proposal = parsedProposal.success ? parsedProposal.data : null;
      const vaultEdit = payload.vaultEdit ?? null;
      const scriptEdit = payload.scriptEdit ?? null;
      if (payload.model) setModel(payload.model);
      // Thread subsequent turns onto the conversation the server persisted this
      // turn under (it minted the id if this was the first message).
      if (payload.conversationId) setConversationId(payload.conversationId);
      setChat((c) => [
        ...c,
        {
          who: "agent",
          at: "just now",
          body: reply,
          proposal,
          proposalState: proposal ? ("pending" as const) : undefined,
          vaultEdit,
          vaultEditReceipt: payload.vaultEditReceipt ?? null,
          vaultEditState: vaultEdit ? ("pending" as const) : undefined,
          scriptEdit,
          scriptEditState: scriptEdit ? ("pending" as const) : undefined,
        },
      ]);
      setLastSent(null);
    } catch (err) {
      if (!isCurrent(operation)) return;
      console.error("[agent-chat] network error:", err);
      const msg = chatErrorMessage({ agentName });
      setError(msg);
      setChat((c) => [
        ...c,
        { who: "agent", at: "just now", body: msg },
      ]);
    } finally {
      if (finish(operation)) setThinking(false);
    }
  };

  /**
   * Force-apply Nova's latest suggestion. The model is chatty and often
   * proposes a rewrite in prose without the structured block — so this sends a
   * constrained follow-up ("output ONLY the edit block") that the model reliably
   * answers, then applies the result. Doesn't depend on it volunteering JSON.
   * The constrained turn isn't shown as a user message.
   */
  const applyLastToScript = async () => {
    if (!instanceId || !onApplyScriptEdit) return;
    const operation = beginAction();
    if (!operation) return;
    conversationStarted.current = true;
    setError(null);
    setThinking(true);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(instanceId)}/chat`, {
        method: "POST",
        signal: operation.controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message:
            "Apply the rewrite you just proposed to the draft. Output ONLY the noelle-script-edit block (valid JSON) implementing it — set the changed beats by their 0-based index and/or fullScript, plus a one-line summary. No prose, no questions.",
          conversationId,
          draftId,
        }),
      });
      if (!res.ok) { if (isCurrent(operation)) setError("Couldn't apply that — try again."); return; }
      const payload = (await res.json()) as { text?: string; scriptEdit?: ScriptEditProposal | null; conversationId?: string };
      if (!isCurrent(operation)) return;
      if (payload.conversationId) setConversationId(payload.conversationId);
      if (payload.scriptEdit) {
        if (!onApplyScriptEdit(payload.scriptEdit)) {
          setError("That edit didn't change the current draft. Ask for an edit to an existing beat or the script.");
          return;
        }
        setChat((c) => [...c, { who: "agent", at: "just now", body: "Done — I dropped those changes into your storyboard. Review them and hit Save." }]);
      } else {
        setChat((c) => [...c, { who: "agent", at: "just now", body: "I couldn't turn that into a concrete edit — tell me which beat or line to change and I'll apply it." }]);
      }
    } catch {
      if (isCurrent(operation)) setError("Couldn't apply that — try again.");
    } finally {
      if (finish(operation)) setThinking(false);
    }
  };

  const cancelProposal = (idx: number) => {
    setChat((c) =>
      c.map((m, i) => (i === idx ? { ...m, proposalState: "cancelled" as const } : m)),
    );
  };

  const cancelVaultEdit = (idx: number) => {
    setChat((c) =>
      c.map((m, i) => (i === idx ? { ...m, vaultEditState: "cancelled" as const } : m)),
    );
  };

  const cancelScriptEdit = (idx: number) => {
    setChat((c) =>
      c.map((m, i) => (i === idx ? { ...m, scriptEditState: "cancelled" as const } : m)),
    );
  };

  const applyScriptEditMsg = (idx: number, edit: ScriptEditProposal) => {
    if (!onApplyScriptEdit) {
      setError("Can't apply edits here — open this draft in the studio.");
      return;
    }
    const operation = beginAction();
    if (!operation) return;
    // Synchronous: the parent loads the new lines into the editor (marked dirty).
    setError(null);
    try {
      if (!onApplyScriptEdit(edit)) {
        setError("That edit didn't change the current draft. Ask for an edit to an existing beat or the script.");
        return;
      }
      setChat((c) => [
        ...c.map((m, i) => (i === idx ? { ...m, scriptEditState: "applied" as const } : m)),
        {
          who: "agent",
          at: "just now",
          body: "Done — I've dropped the changes into your storyboard. Review them and hit Save to keep them.",
        },
      ]);
    } catch {
      setError("Couldn't load that edit. Try again in a moment.");
    } finally {
      finish(operation);
    }
  };

  const applyVaultEditMsg = async (idx: number) => {
    if (!instanceId || !orgSlug) {
      setError("Can't apply changes here — missing workspace context.");
      return;
    }
    const receipt = chat[idx]?.vaultEditReceipt;
    if (!receipt?.eligible || !receipt.messageId) return;
    const operation = beginAction();
    if (!operation) return;
    setApplyingVaultIdx(idx);
    setError(null);
    try {
      const result = await applyVaultEdit({ orgSlug, instanceId, messageId: receipt.messageId });
      if (!isCurrent(operation)) return;
      if (!result.ok) {
        if (result.error === "conflict" || result.error === "refresh_required") {
          setChat((c) => c.map((m, i) => i === idx ? { ...m, vaultEditReceipt: { ...receipt, eligible: false, refreshReason: "changed" } } : m));
        }
        setError(
          result.error === "forbidden"
            ? "You don't have permission to edit this vault."
            : result.error === "no_vault"
              ? "No vault is connected to this workspace."
              : result.error === "conflict"
                ? "This file changed since this proposal. Refresh it before applying an edit."
                : result.error === "refresh_required"
                  ? "This proposal needs the complete current file. Refresh it before applying."
                  : result.error === "uncertain"
                    ? "The write could not be confirmed. Retry this proposal to check the saved contents."
              : "Couldn't apply that edit. Try again in a moment.",
        );
        return;
      }
      setChat((c) => [
        ...c.map((m, i) =>
          i === idx ? { ...m, vaultEditState: "applied" as const } : m,
        ),
        {
          who: "agent",
          at: "just now",
          body: `Done — updated ${result.path} in your vault. The interns re-read it automatically, so it shapes how posts get written from here.`,
        },
      ]);
    } catch (err) {
      if (!isCurrent(operation)) return;
      console.error("[agent-chat] applyVaultEdit failed:", err);
      setError("Couldn't apply that edit. Try again in a moment.");
    } finally {
      if (finish(operation)) setApplyingVaultIdx(null);
    }
  };

  const applyProposal = async (idx: number, proposal: TargetingProposal) => {
    if (!targetingProposalMatchesRole(proposal, agentRole)) {
      setError("That targeting change belongs to a different agent role.");
      return;
    }
    if (!instanceId || !orgSlug) {
      setError("Can't apply changes here — missing workspace context.");
      return;
    }
    const operation = beginAction();
    if (!operation) return;
    setApplyingIdx(idx);
    setError(null);
    try {
      const result = await applyTargetingChange({ orgSlug, instanceId, proposal });
      if (!isCurrent(operation)) return;
      if (!result.ok || !result.applied) {
        setError(
          result.error === "forbidden"
            ? "You don't have permission to change this agent."
            : "Couldn't apply that change. Try again in a moment.",
        );
        return;
      }
      setChat((c) => [
        ...c.map((m, i) =>
          i === idx ? { ...m, proposalState: "applied" as const } : m,
        ),
        {
          who: "agent",
          at: "just now",
          body: `Done — ${summarizeApplied(result.applied)}. The next configured sweep will use it.`,
        },
      ]);
    } catch (err) {
      if (!isCurrent(operation)) return;
      console.error("[agent-chat] applyTargetingChange failed:", err);
      setError("Couldn't apply that change. Try again in a moment.");
    } finally {
      if (finish(operation)) setApplyingIdx(null);
    }
  };

  return (
    <div
      style={
        fillHeight
          ? { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }
          : undefined
      }
    >
      <div
        ref={scrollRef}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 14,
          // Fill mode: grow to fill the bounded parent and pin the composer to
          // the bottom. Default: the original fixed cap on the agent detail page.
          ...(fillHeight ? { flex: 1, minHeight: 0 } : { maxHeight: 380 }),
          overflowY: "auto",
          padding: "4px 2px 14px",
        }}
      >
        {chat.map((m, i) => (
          <ChatRow
            key={i}
            m={m}
            agentRole={agentRole}
            agentName={agentName}
            userInitial={userInitial}
            userName={userName}
            onPick={canSend ? send : undefined}
            canApply={!!instanceId && !!orgSlug}
            applying={applyingIdx === i}
            applyDisabled={busy}
            onApply={m.proposal ? () => applyProposal(i, m.proposal!) : undefined}
            onCancel={m.proposal ? () => cancelProposal(i) : undefined}
            applyingVault={applyingVaultIdx === i}
            vaultApplyDisabled={busy}
            onApplyVaultEdit={m.vaultEdit ? () => applyVaultEditMsg(i) : undefined}
            onRefreshVaultEdit={m.vaultEdit ? () => send(`Read the complete current file ${m.vaultEdit!.path} and propose this change while preserving its other rules: ${m.vaultEdit!.summary}`, { vaultPath: m.vaultEdit!.path }) : undefined}
            onCancelVaultEdit={m.vaultEdit ? () => cancelVaultEdit(i) : undefined}
            canApplyScriptEdit={!!onApplyScriptEdit && !busy}
            onApplyScriptEdit={m.scriptEdit ? () => applyScriptEditMsg(i, m.scriptEdit!) : undefined}
            onCancelScriptEdit={m.scriptEdit ? () => cancelScriptEdit(i) : undefined}
          />
        ))}
        {thinking ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: 12,
              color: "var(--ink-muted)",
            }}
          >
            <Avatar role={agentRole as AvatarRole} size={22} />
            <span style={{ fontFamily: "var(--mono)" }}>{agentName}</span>
            <span style={{ display: "inline-flex", gap: 3 }}>
              {[0, 1, 2].map((j) => (
                <span
                  key={j}
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: "var(--ink-soft)",
                    animation: "pulse 1.2s infinite ease-out",
                    animationDelay: `${j * 150}ms`,
                  }}
                />
              ))}
            </span>
          </div>
        ) : null}
      </div>

      <div
        style={{
          padding: "10px 12px",
          background: "var(--paper-2)",
          borderRadius: 12,
          boxShadow: "0 0 0 0.5px var(--rule)",
          opacity: instanceId ? 1 : 0.6,
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!instanceId}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(draft);
          }}
          placeholder={
            instanceId
              ? `Ask ${agentName}… e.g. "what should I focus on today?"  (⌘↵ to send)`
              : `${agentName} isn't provisioned yet — chat unlocks once the agent is hired.`
          }
          rows={2}
          style={{
            width: "100%",
            border: 0,
            background: "transparent",
            outline: "none",
            resize: "none",
            fontFamily: "var(--body)",
            fontSize: 13.5,
            lineHeight: 1.5,
            color: "var(--ink)",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              color: "var(--ink-muted)",
            }}
          >
            {instanceId
              ? `Remembers this chat · ${prettyModel(model)}`
              : "Read-only preview"}
          </span>
          {onApplyScriptEdit && chat.length > 1 ? (
            <button
              type="button"
              className="btn btn-sm"
              style={{ marginLeft: "auto" }}
              disabled={!canSend}
              title="Turn Nova's latest suggestion into an edit and drop it into the storyboard"
              onClick={applyLastToScript}
            >
              ✎ Apply to script
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={onApplyScriptEdit && chat.length > 1 ? undefined : { marginLeft: "auto" }}
            title="Start a fresh conversation (your earlier chats are kept)"
            onClick={() => {
              invalidate();
              conversationStarted.current = false;
              setError(null);
              setDraft("");
              setThinking(false);
              setLastSent(null);
              setModel(null);
              setApplyingIdx(null);
              setApplyingVaultIdx(null);
              // Detach from the current thread so the next message starts a new
              // one. The earlier conversation stays persisted in the DB.
              setConversationId(null);
              setChat([
                { who: "agent", at: "just now", body: fallback.body, suggestions: fallback.suggestions },
              ]);
              void loadGreeting(false);
            }}
          >
            New chat
          </button>
          <button
            type="button"
            className="btn btn-sm btn-accent"
            onClick={() => send(draft)}
            disabled={!canSend || !draft.trim()}
            style={
              !canSend || !draft.trim()
                ? { opacity: 0.5, cursor: "not-allowed" }
                : undefined
            }
          >
            Send ↵
          </button>
        </div>
        {error ? (
          <div
            style={{
              marginTop: 6,
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 11.5,
              color: "var(--warn)",
              fontFamily: "var(--mono)",
            }}
          >
            <span style={{ flex: 1 }}>{error}</span>
            {lastSent && !thinking ? (
              <button
                type="button"
                onClick={() => send(lastSent.message, { isRetry: true, vaultPath: lastSent.vaultPath })}
                style={{
                  border: 0,
                  background: "transparent",
                  color: "var(--accent)",
                  cursor: "pointer",
                  fontFamily: "var(--mono)",
                  fontSize: 11.5,
                  textDecoration: "underline",
                  padding: 0,
                }}
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ChatRow({

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

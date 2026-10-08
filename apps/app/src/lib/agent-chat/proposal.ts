import {
  TargetingProposalSchema,
  type TargetingProposal,
  VaultEditProposalSchema,
  type VaultEditProposal,
  ScriptEditProposalSchema,
  type ScriptEditProposal,
} from "@noelle/contracts";
import { z } from "zod";
import type { VaultFileBasis } from "../vault-fs";
import type { VaultSnapshot, VaultRefreshReason } from "../vault-snapshot";

const identitySchema = z.object({
  dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/), size: z.string().regex(/^\d+$/),
  mtimeNs: z.string().regex(/^-?\d+$/), ctimeNs: z.string().regex(/^-?\d+$/),
});
const basisCommon = { version: z.literal(1), path: VaultEditProposalSchema.shape.path, rootIdentity: z.string().regex(/^[a-f0-9]{64}$/) };
const basisSchema = z.discriminatedUnion("exists", [
  z.object({ ...basisCommon, exists: z.literal(true), contentSha256: z.string().regex(/^[a-f0-9]{64}$/), fileIdentity: identitySchema }),
  z.object({ ...basisCommon, exists: z.literal(false) }),
]);
const refreshReasonSchema = z.enum(["partial", "unseen", "unavailable", "too_large", "invalid_encoding", "changed", "no_vault", "legacy"]);
const storedVaultEditSchema = z.object({
  version: z.literal(1), agentRole: z.string().min(1).max(64), proposal: VaultEditProposalSchema,
  basis: basisSchema.optional(), refreshReason: refreshReasonSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.basis && (value.basis.path !== value.proposal.path || value.refreshReason)) ctx.addIssue({ code: "custom", message: "Inconsistent vault basis" });
});
export interface StoredVaultEdit {
  version: 1; agentRole: string; proposal: VaultEditProposal; basis?: VaultFileBasis;
  refreshReason?: VaultRefreshReason | "legacy";
}
export interface VaultEditClientReceipt {
  messageId: string | null; eligible: boolean; refreshReason: VaultRefreshReason | "legacy" | "not_saved" | null;
}

/** Bind only the complete source captured by the server before generation. */
export function bindVaultEdit(proposal: VaultEditProposal, snapshot: VaultSnapshot, agentRole: string): StoredVaultEdit {
  const basis = snapshot.bases[proposal.path];
  return basis
    ? { version: 1, agentRole, proposal, basis }
    : { version: 1, agentRole, proposal, refreshReason: snapshot.refreshReasons[proposal.path] ?? "unseen" };
}
export function parseStoredVaultEdit(value: unknown): StoredVaultEdit | null {
  const stored = storedVaultEditSchema.safeParse(value);
  if (stored.success) return stored.data;
  const legacy = VaultEditProposalSchema.safeParse(value);
  return legacy.success ? { version: 1, agentRole: "legacy", proposal: legacy.data, refreshReason: "legacy" } : null;
}

/** Only public eligibility and a durable identifier leave the server. */
export function publicVaultEditReceipt(stored: StoredVaultEdit, messageId: string | null): VaultEditClientReceipt {
  const id = z.string().uuid().safeParse(messageId);
  if (!id.success) return { messageId: null, eligible: false, refreshReason: "not_saved" };
  return { messageId: id.data, eligible: Boolean(stored.basis) && !stored.refreshReason, refreshReason: stored.basis ? null : stored.refreshReason ?? "unseen" };
}

/**
 * Extract a Vega targeting/mission proposal from a chat reply.
 *
 * The chat LLM is instructed (see @noelle/agents/chat/x_intern.ts) to append a
 * fenced ```noelle-proposal block of TargetingProposal JSON when — and only
 * when — the founder asked to change what the agent hunts for or its mission.
 * The route never lets the model touch the DB; it extracts the block here,
 * validates it against the contract, and hands the validated proposal to the
 * client for an explicit Apply (which replays it through the
 * applyTargetingChange server action).
 *
 * The block is always stripped from the displayed text (the founder should
 * never see raw JSON), even when validation fails — in that case we just
 * return `proposal: null` and the natural-language sentence stands alone.
 */

// Capture the FIRST block (the one we validate + return).
const BLOCK_RE = /```noelle-proposal\s*([\s\S]*?)```/i;
// Strip EVERY block from the display text — the prompt says "never emit more
// than one", but if the model slips and emits multiple, none should leak to the
// founder as raw JSON.
const BLOCK_RE_ALL = /```noelle-proposal\s*[\s\S]*?```/gi;

export interface ExtractedProposal {
  /** Model reply with the proposal block removed. */
  text: string;
  /** Validated proposal, or null when absent/invalid. */
  proposal: TargetingProposal | null;
}

export function extractProposal(raw: string): ExtractedProposal {
  const match = raw.match(BLOCK_RE);
  if (!match) return { text: raw.trim(), proposal: null };

  const jsonText = (match[1] ?? "").trim();
  const stripped = raw.replace(BLOCK_RE_ALL, "").trim();
  const text = stripped || "Here's the change I'd make — review and apply it below.";

  let proposal: TargetingProposal | null = null;
  try {
    const validated = TargetingProposalSchema.safeParse(JSON.parse(jsonText));
    if (validated.success) proposal = validated.data;
  } catch {
    // Malformed JSON in the block → no proposal, text stands alone.
  }

  return { text, proposal };
}

// Historical vault-edit proposals remain readable. Extract and validate the
// block here, then strip it from the displayed text. This parser never writes
// a file; applying an edit requires explicit confirmation and a valid receipt.
const VAULT_BLOCK_RE = /```noelle-vault-edit\s*([\s\S]*?)```/i;
const VAULT_BLOCK_RE_ALL = /```noelle-vault-edit\s*[\s\S]*?```/gi;

export interface ExtractedVaultEdit {
  text: string;
  vaultEdit: VaultEditProposal | null;
}

export function extractVaultEdit(raw: string): ExtractedVaultEdit {
  const match = raw.match(VAULT_BLOCK_RE);
  if (!match) return { text: raw.trim(), vaultEdit: null };

  const jsonText = (match[1] ?? "").trim();
  const stripped = raw.replace(VAULT_BLOCK_RE_ALL, "").trim();
  const text = stripped || "Here's the vault edit I'd make — review and apply it below.";

  let vaultEdit: VaultEditProposal | null = null;
  try {
    const validated = VaultEditProposalSchema.safeParse(JSON.parse(jsonText));
    if (validated.success) vaultEdit = validated.data;
  } catch {
    // Malformed JSON → no edit, text stands alone.
  }

  return { text, vaultEdit };
}

// Nova (the video refiner) emits a ```noelle-script-edit block when the operator
// asks it to change the open draft's hook / beats / script. Same propose-then-
// apply contract: extract + validate here, strip from the displayed text, and
// only mutate the editor when the operator hits Apply (which loads the new lines
// into the studio for review before Save). Never an autonomous write.
const SCRIPT_BLOCK_RE = /```noelle-script-edit\s*([\s\S]*?)```/i;
const SCRIPT_BLOCK_RE_ALL = /```noelle-script-edit\s*[\s\S]*?```/gi;

export interface ExtractedScriptEdit {
  text: string;
  scriptEdit: ScriptEditProposal | null;
}

export function extractScriptEdit(raw: string): ExtractedScriptEdit {
  const match = raw.match(SCRIPT_BLOCK_RE);
  if (!match) return { text: raw.trim(), scriptEdit: null };

  const jsonText = (match[1] ?? "").trim();
  const stripped = raw.replace(SCRIPT_BLOCK_RE_ALL, "").trim();
  const text = stripped || "Here's the rewrite — review and apply it below.";

  let scriptEdit: ScriptEditProposal | null = null;
  try {
    const validated = ScriptEditProposalSchema.safeParse(normalizeScriptEdit(JSON.parse(jsonText)));
    if (validated.success) scriptEdit = validated.data;
  } catch {
    // Malformed JSON → no edit, text stands alone.
  }

  return { text, scriptEdit };
}

/**
 * Coerce the model's slightly-varied shapes to the contract: `line`/`text`,
 * `fullScript`/`full_script`/`script`, `summary`/`note`, and beat `index`/`beat`
 * possibly as strings. Keeps the apply working even when the model drifts on key
 * names — the schema still rejects anything genuinely unusable.
 */
function normalizeScriptEdit(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const o = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (Array.isArray(o.beats)) {
    out.beats = o.beats
      .map((b) => {
        if (!b || typeof b !== "object") return null;
        const r = b as Record<string, unknown>;
        const index = Number(r.index ?? r.beat ?? r.i);
        const line = r.line ?? r.text ?? r.newLine ?? r.value;
        if (!Number.isFinite(index) || typeof line !== "string") return null;
        return { index, line };
      })
      .filter(Boolean);
  }
  const full = o.fullScript ?? o.full_script ?? o.script;
  if (typeof full === "string") out.fullScript = full;
  const summary = o.summary ?? o.note ?? o.description;
  out.summary = typeof summary === "string" && summary.trim() ? summary : "Script edit";
  return out;
}

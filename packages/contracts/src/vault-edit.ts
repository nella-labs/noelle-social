import { z } from "zod";

export const VAULT_EDIT_MAX_CHARACTERS = 50_000;

/**
 * A vault edit the Head of Growth (CMO) chat proposes when the founder asks to
 * change their voice / brand / content rules. Same propose-then-confirm shape as
 * TargetingProposalSchema: the chat LLM emits a fenced ```noelle-vault-edit block
 * of this JSON, the route extracts + validates it, and it only becomes a real
 * file write when the founder clicks Apply (which replays it through the
 * applyVaultEdit server action). The LLM never writes the vault directly.
 */
export const VaultEditProposalSchema = z.object({
  // Vault-relative path of the markdown file to write (the server re-validates
  // it stays inside the vault and ends in .md).
  path: z.string().min(1).max(300),
  // The FULL new contents of the file (replace, not patch — simpler + reviewable).
  content: z.string().min(1).max(VAULT_EDIT_MAX_CHARACTERS),
  // One-line human summary of the change, shown on the Apply card.
  summary: z.string().min(1).max(300),
});
export type VaultEditProposal = z.infer<typeof VaultEditProposalSchema>;

export interface VaultFile {
  type: "file";
  name: string;
  path: string;
  /** Full file body. Absent for live GCS files until fetched on demand. */
  body?: string;
  /** ISO date of last edit. */
  lastModifiedISO: string;
  /** Word count, when the body is known. */
  wordCount?: number;
  /** Agent slugs that have anchored against this file. */
  anchoredBy?: string[];
}

export interface VaultFolder {
  type: "folder";
  name: string;
  path: string;
  children: VaultNode[];
}

export type VaultNode = VaultFile | VaultFolder;

export interface AnchorUsage {
  /** Short label of the draft that pulled these anchors. */
  draftTitle: string;
  /** Which agent produced the draft. */
  agentSlug: string;
  /** Human label for the agent (no DB lookup needed at render). */
  agentLabel: string;
  /** When the draft was produced. ISO. */
  whenISO: string;
  /** Vault file paths the drafter pulled as anchors. */
  anchorPaths: string[];
}

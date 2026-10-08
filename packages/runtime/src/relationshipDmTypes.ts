import type { ModelRouting } from "./types.js";

export type RelationshipDmPlatform = "linkedin" | "x";

export interface RelationshipDmEvidence {
  id: string;
  kind: "post" | "profile" | "note" | "sent_reply" | "sent_dm" | "received_reply";
  text: string;
  url?: string | null;
  occurredAt?: string | null;
}

export interface RelationshipDmCandidate {
  reservationId: string;
  requestId?: string | null;
  authorId: string;
  authorHandle: string;
  name: string | null;
  profileUrl: string;
  context: RelationshipDmEvidence[];
}

export interface RelationshipDmRunner {
  draft(args: {
    bucket: string;
    routing: ModelRouting;
    orgId: string;
    instanceId: string;
    worker: string;
    agentRole: "linkedin_intern" | "x_intern";
    system: string;
    prompt: string;
  }): Promise<{ text: string; engine: string; model: string }>;
}

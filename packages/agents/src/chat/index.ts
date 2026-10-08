/**
 * Chat profiles for every Noelle agent role.
 *
 * Each role ships three artifacts: a TS class (`types/<role>.ts`), a
 * YAML manifest (`registry/<role>.yaml`), and a chat profile (this
 * folder). The first two are described in docs/agent-model.md §1; the
 * chat profile is documented in docs/agent-model.md §3.x.
 *
 * Keep this file the single source of truth for which roles have a
 * chat profile. The route layer asserts presence, so a missing entry
 * fails loudly instead of silently falling back to a generic prompt.
 */
import type { AgentRole } from "../types.js";
import type { AgentChatProfile } from "./types.js";
import { xInternChatProfile } from "./x_intern.js";
import { linkedinInternChatProfile } from "./linkedin_intern.js";
import { redditInternChatProfile } from "./reddit_intern.js";
import { videoInternChatProfile } from "./video_intern.js";

export type { AgentChatProfile } from "./types.js";
export type {
  AgentChatContext,
  ChatApprovalSummary,
  ChatActivityEvent,
  ChatLeadSummary,
  ChatTargeting,
  ChatVideoIntel,
  ChatVideoBrandGuideEntry,
  ChatVideoClip,
  ChatVideoDraft,
  ChatVideoBeat,
  ChatVideoInspiration,
  ChatWorkerFreshness,
  GreetingArgs,
  GreetingResult,
  SystemPromptArgs,
} from "./types.js";
export {
  xInternChatProfile,
  linkedinInternChatProfile,
  redditInternChatProfile,
  videoInternChatProfile,
};

const PROFILES: Readonly<Record<AgentRole, AgentChatProfile>> = {
  x_intern: xInternChatProfile,
  linkedin_intern: linkedinInternChatProfile,
  reddit_intern: redditInternChatProfile,
  video_intern: videoInternChatProfile,
};

export function getChatProfile(role: AgentRole): AgentChatProfile {
  const profile = PROFILES[role];
  if (!profile) {
    throw new Error(
      `No chat profile for agent role ${role}. Add one in packages/agents/src/chat/<role>.ts and register it in chat/index.ts.`,
    );
  }
  return profile;
}

/** Defensive lookup for routes that may receive a string the type system can't constrain. */
export function tryGetChatProfile(role: string): AgentChatProfile | null {
  if (
    role === "x_intern" ||
    role === "linkedin_intern" ||
    role === "reddit_intern" ||
    role === "video_intern"
  ) {
    return PROFILES[role];
  }
  return null;
}

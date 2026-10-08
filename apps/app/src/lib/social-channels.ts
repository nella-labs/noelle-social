import { SOCIAL_AGENT_ROLES, type AgentRole } from "@noelle/contracts";

export interface SocialChannel {
  role: AgentRole;
  platform: "x" | "linkedin" | "reddit" | "video";
  label: string;
  setupSlug: string;
  stream: string | null;
  description: string;
}

const CHANNEL_DETAILS: Record<AgentRole, Omit<SocialChannel, "role">> = {
  x_intern: { platform: "x", label: "X", setupSlug: "x-intern", stream: "x-intern", description: "Find relevant conversations, review replies, and plan original posts." },
  linkedin_intern: { platform: "linkedin", label: "LinkedIn", setupSlug: "linkedin-intern", stream: "linkedin-intern", description: "Follow people and topics, write thoughtful replies, and prepare posts." },
  reddit_intern: { platform: "reddit", label: "Reddit", setupSlug: "reddit-intern", stream: "reddit-intern", description: "Find useful threads in your communities and prepare replies." },
  video_intern: { platform: "video", label: "Short video", setupSlug: "video-intern", stream: null, description: "Study creators and prepare scripts for Instagram and TikTok." },
};

export const SOCIAL_CHANNELS: readonly SocialChannel[] = SOCIAL_AGENT_ROLES.map(role => ({ role, ...CHANNEL_DETAILS[role] }));

export function channelForRole(role: string): SocialChannel | undefined {
  return SOCIAL_CHANNELS.find((channel) => channel.role === role);
}

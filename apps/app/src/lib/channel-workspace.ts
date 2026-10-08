import "server-only";
import type { NoelleAgentInstance } from "@/lib/db-types";
import { measure } from "@/lib/growth-overview";
import {
  getAutoSendUsage, getPipelineSnapshot, getLinkedInPipelineSnapshot, getRedditPipelineSnapshot,
  listAutoSendQueueForInstance, listRecentSentForInstance, listRecentActivityForInstance,
  countLinkedInWatchlistPeople,
} from "@/lib/queries";
import { getIntelligenceStatus } from "@/lib/posts-queries";

export async function loadChannelWorkspace(instance: NoelleAgentInstance) {
  const isX = instance.role === "x_intern";
  const isLinkedIn = instance.role === "linkedin_intern";
  const pipelineLoad = isX ? getPipelineSnapshot : isLinkedIn ? getLinkedInPipelineSnapshot : instance.role === "reddit_intern" ? getRedditPipelineSnapshot : null;
  const [pipeline, activity, queue, sent, usage, intelligence, watched] = await Promise.all([
    pipelineLoad ? measure(() => pipelineLoad(instance.id)) : null,
    measure(() => listRecentActivityForInstance(instance.id, 5)),
    isX ? measure(() => listAutoSendQueueForInstance(instance.id)) : null,
    isX ? measure(() => listRecentSentForInstance(instance.id, 15)) : null,
    isX && process.env.NOELLE_AUTOPILOT_PANEL === "1" ? measure(() => getAutoSendUsage(instance.id)) : null,
    isLinkedIn ? measure(() => getIntelligenceStatus(instance.org_id, instance.id)) : null,
    isLinkedIn ? measure(() => countLinkedInWatchlistPeople(instance.id)) : null,
  ]);
  return { pipeline, activity, queue, sent, usage, intelligence, watched };
}

export type ChannelWorkspaceData = Awaited<ReturnType<typeof loadChannelWorkspace>>;

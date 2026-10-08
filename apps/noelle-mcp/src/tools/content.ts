import { markContentPostReady, dismissContentPost, scheduleContentPostIdea } from "@noelle/runtime";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { NoelleError, type NoelleContext } from "../context.js";
import type { ToolModule, ToolResult } from "../types.js";
import { guard, mdTable, text, truncate } from "../result.js";
import { getIdeationRequest } from "./content-ideation.js";
import {
  generatePostWithProgress,
  getPostWithFullDrafts,
} from "./content-posts.js";
import {
  AGENT_SELECTOR_PROPS,
  LIMIT_PROP,
  ORG_PROP,
  limitOf,
  optNum,
  optStr,
  optStrArray,
  reqStr,
  resolveAgentInstance,
} from "./_shared.js";

// The Posts pipeline: post_ideas (idea cards the ideation worker proposes) and
// post_drafts (the bodies the post-drafter worker writes per platform). These
// tools mirror the Content lane of the dashboard — list/inspect the queue,
// nudge the workers (trigger ideation, approve an idea for drafting), and take
// the human decisions (schedule, mark ready, dismiss). Heavy generation stays
// on the workers; these tools just insert requests / flip statuses.

// Statuses list_post_ideas surfaces by default (the live funnel, minus dismissed).
const DEFAULT_IDEA_STATUSES = ["proposed", "approved", "drafting", "drafted", "ready"];

const tools: Tool[] = [
  {
    name: "noelle_list_post_ideas",
    description:
      "List post ideas (the idea cards the ideation worker proposes) for an org. Defaults to the live funnel (proposed, approved, drafting, drafted, ready); pass `status` to filter to one, or `platform` to filter by target platform.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        status: {
          type: "string",
          description:
            "Filter to one status (proposed, approved, drafting, drafted, ready, dismissed). Omit for the live funnel.",
        },
        platform: {
          type: "string",
          description:
            "Filter to ideas whose platform / target platforms include this (e.g. linkedin, x, reddit).",
        },
        limit: LIMIT_PROP,
      },
    },
  },
  {
    name: "noelle_list_post_drafts",
    description:
      "List the latest post draft per (idea, platform) for an org: platform, status/stage, quality score, and a body snippet. Defaults to all statuses; pass `status` (draft, ready, dismissed) or `platform` to filter.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        status: {
          type: "string",
          description: "Filter drafts to one status (draft, ready, dismissed).",
        },
        platform: {
          type: "string",
          description: "Filter drafts to one platform (linkedin, x, reddit).",
        },
        limit: LIMIT_PROP,
      },
    },
  },
  {
    name: "noelle_get_post",
    description:
      "Get one post idea with all draft revisions and full bodies, plus per-platform progress and the real worker reviewer/verifier metadata when present.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        ideaId: { type: "string", description: "The post idea uuid." },
        requestId: {
          type: "string",
          description:
            "Optional post generation request uuid returned by noelle_generate_post; limits progress and bodies to that request.",
        },
        waitSeconds: {
          type: "number",
          description:
            "Optional bounded wait for this request's real worker-created draft/reviewer result. Max 45 seconds.",
        },
      },
      required: ["ideaId"],
    },
  },
  {
    name: "noelle_add_post_idea",
    description:
      "Manually add a post idea to an agent's queue (status=proposed). Requires a hook; thesis/angle/pillar/suggestedDay optional. Defaults platform to linkedin and target_platforms to [platform].",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        ...AGENT_SELECTOR_PROPS,
        hook: {
          type: "string",
          description: "The scroll-stopping first line / premise of the post.",
        },
        thesis: { type: "string", description: "The core point the post argues." },
        angle: { type: "string", description: "The framing / point of view." },
        pillar: { type: "string", description: "Content pillar this belongs to." },
        suggestedDay: { type: "string", description: "Suggested publish day, YYYY-MM-DD." },
        platform: { type: "string", description: "Primary platform (default linkedin)." },
        targetPlatforms: {
          type: "array",
          items: { type: "string" },
          description: "Platforms this idea should fan out into (default [platform]).",
        },
      },
      required: ["hook"],
    },
  },
  {
    name: "noelle_trigger_ideation",
    description:
      "Ask Noelle to generate ideas from saved posts and the operator's sent replies, without Apify or fresh discovery. mode 'single' requests up to `count` ideas; mode 'batch' requests a weekly set. Optional topics guide the synthesis. Returns a request id: poll noelle_get_ideation_request for the worker's actual ideas and source references. Do not substitute chat-written ideas.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        ...AGENT_SELECTOR_PROPS,
        mode: {
          type: "string",
          enum: ["single", "batch"],
          description: "Ideation mode (default single).",
        },
        count: { type: "number", description: "single mode: how many ideas to request." },
        topics: {
          type: "array",
          items: { type: "string" },
          description: "Optional topic guidance for ideas grounded in saved replied posts.",
        },
        platform: {
          type: "string",
          description: "Target platform for the produced ideas (default linkedin).",
        },
      },
    },
  },
  {
    name: "noelle_get_ideation_request",
    description:
      "Read one Noelle ideation request, its progress or worker error, and its exact saved idea batch with full premises and source references. Poll the same request until done or error, then use returned idea IDs for drafting.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        requestId: { type: "string", description: "The ideation request UUID." },
        waitSeconds: { type: "number", minimum: 0, maximum: 45, description: "Optional bounded wait for worker completion." },
      },
      required: ["requestId"],
    },
  },
  {
    name: "noelle_generate_post",
    description:
      "Approve or requeue a post idea for real worker drafting. Optional `platforms` scopes a regenerate to linkedin/x/reddit; omit it to draft every target platform. Optional `guidance` is stored as a post-scoped drafter note that the worker reads. Optional `waitSeconds` (max 45) polls for new worker-created draft ids and returns full bodies only when they exist.",
    inputSchema: {
      type: "object",
      properties: {
        org: ORG_PROP,
        ideaId: { type: "string", description: "The post idea uuid to approve." },
        guidance: {
          type: "string",
          description:
            "Optional framing / anecdote / things-to-avoid for the drafter (stored as a drafter note).",
        },
        platforms: {
          type: "array",
          items: { type: "string", enum: ["linkedin", "x", "reddit"] },
          description:
            "Optional platform subset for a new version. Omit to draft every target platform; pass one or more to add/scope those platform revisions.",
        },
        waitSeconds: {
          type: "number",
          description:
            "Optional bounded wait for real worker-created drafts. Max 45 seconds. Default 0 returns queued/progress status immediately.",
        },
      },
      required: ["ideaId"],
    },
  },
  {
    name: "noelle_schedule_post",
    description:
      "Set (or clear) an idea's suggested publish day. Pass `day` as YYYY-MM-DD, or omit it to clear the suggestion. This does not create a publication slot.",
    inputSchema: {

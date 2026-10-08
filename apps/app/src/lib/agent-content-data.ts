import "server-only";
import {
  configForPlatform,
  type ContentPlatform,
  type WorkspaceLaneView,
} from "@/lib/agent-content-config";
import { getOrgBySlug, listAgentInstancesForOrg } from "@/lib/queries";
import { listFeederSources } from "@/lib/feeder-queries";
import {
  listPostIdeasForOrg,
  listPostDraftsForOrg,
  listContentMediaForOrg,
} from "@/lib/posts-queries";
import { resolveNovaInstance, getStudioBoard } from "@/lib/video-studio-queries";
import { listVideoClips } from "@/lib/video-queries";
import { listExternalMedia } from "@/lib/external-media";
import type { WorkspaceSection } from "@/lib/agent-content-config";

/**
 * Server-only loader for the `/content` workspace. It collapses the two
 * branches the page used to carry (text lanes vs the Nova video lane) into ONE
 * discriminated result the shell + outlet render generically. New sections
 * (Schedule, Compose) extend this loader + the outlet — never the page.
 *
 * `server-only` is stubbed under vitest (see vitest.config.ts), so this module
 * is importable from tests too.
 */

/** The sections that resolve to a `?board=` value. */
export type ContentBoard = Extract<
  WorkspaceSection,
  "overview" | "ideas" | "drafts" | "media" | "schedule" | "compose" | "performance" | "voice" | "trending"
>;

/** Raw `?platform=` for the text lanes (null = the "All" aggregate). */
export type TextPlatform = "linkedin" | "x" | "reddit" | null;

type IdeaRow = Awaited<ReturnType<typeof listPostIdeasForOrg>>[number];
type DraftRow = Awaited<ReturnType<typeof listPostDraftsForOrg>>[number];
type ContentMediaRow = Awaited<ReturnType<typeof listContentMediaForOrg>>[number];
type ExternalMediaRow = Awaited<ReturnType<typeof listExternalMedia>>[number];
export type MediaRow = ContentMediaRow | ExternalMediaRow;

type Nova = NonNullable<Awaited<ReturnType<typeof resolveNovaInstance>>>;
type StudioBoard = Awaited<ReturnType<typeof getStudioBoard>>;
type VideoIdeaRow = StudioBoard["ideas"][number];
type VideoDraftRow = StudioBoard["drafts"][number];
type ClipRow = Awaited<ReturnType<typeof listVideoClips>>[number];

export type WorkspaceData =
  | { kind: "not-found" }
  | { kind: "video-unhired"; lane: WorkspaceLaneView; orgSlug: string; section: ContentBoard }
  | {
      kind: "video";
      lane: WorkspaceLaneView;
      orgSlug: string;
      section: ContentBoard;
      instanceId: string;
      objective: Nova["objective"];
      displayName: Nova["displayName"];
      ideas: VideoIdeaRow[];
      drafts: VideoDraftRow[];
      clips: ClipRow[];
      counts: Partial<Record<WorkspaceSection, number>>;
    }
  | {
      kind: "text";
      lane: WorkspaceLaneView;
      orgSlug: string;
      section: ContentBoard;
      platform: TextPlatform;
      today: string;
      ideas: IdeaRow[];
      drafts: DraftRow[];
      media: MediaRow[];
      focusId: string | null;
      counts: Partial<Record<WorkspaceSection, number>>;
      /**
       * Pinned-style picker inputs for the Drafts studio (LinkedIn intern only;
       * null when there's no LinkedIn intern / no ingested style sources). Lets
       * the operator "write in this exact person's style" right from the studio.
       */
      style: {
        instanceId: string;
        sources: { handle: string; displayName: string | null }[];
        pinnedStyleHandle: string | null;
      } | null;
    };

export function parseBoard(boardParam?: string): ContentBoard {
  return boardParam === "drafts"
    ? "drafts"
    : boardParam === "ideas"
      ? "ideas"
      : boardParam === "media"
        ? "media"
        : boardParam === "schedule"
          ? "schedule"
          : boardParam === "compose"
            ? "compose"
            : boardParam === "performance"
              ? "performance"
              : boardParam === "voice"
                ? "voice"
                : boardParam === "trending"
                  ? "trending"
                  : "overview";
}

export async function loadWorkspaceData(args: {
  orgSlug: string;
  platformParam?: string;
  boardParam?: string;
  focusParam?: string;
}): Promise<WorkspaceData> {
  const { orgSlug } = args;
  const section = parseBoard(args.boardParam);

  // Raw ?platform= (null = All). Only the three text platforms are honoured
  // here; "video" is its own lane.
  const platform: TextPlatform =
    args.platformParam === "linkedin" || args.platformParam === "x" || args.platformParam === "reddit"
      ? args.platformParam
      : null;
  const isVideo = args.platformParam === "video";
  const activePlatform: ContentPlatform = isVideo ? "video" : (platform ?? "all");
  const lane = configForPlatform(activePlatform);

  // ── Video lane (Nova · IG/TikTok): its own data, same chrome. ──
  if (isVideo) {
    const nova = await resolveNovaInstance(orgSlug);
    if (!nova) return { kind: "video-unhired", lane, orgSlug, section };

    const [board, clips] = await Promise.all([
      getStudioBoard(nova.instanceId),
      listVideoClips(nova.instanceId, { limit: 200 }),
    ]);
    const proposedCount = board.ideas.filter((i) => i.status === "proposed").length;
    return {
      kind: "video",
      lane,
      orgSlug,
      section,
      instanceId: nova.instanceId,
      objective: nova.objective,
      displayName: nova.displayName,
      ideas: board.ideas,
      drafts: board.drafts,
      clips,
      counts: { ideas: proposedCount, drafts: board.drafts.length, media: clips.length },
    };
  }

  // ── Text lanes (All / LinkedIn / X / Reddit) ──
  const org = await getOrgBySlug(orgSlug);
  if (!org) return { kind: "not-found" };

  // Server-computed calendar anchor (YYYY-MM-DD) — passed to the client panels
  // so their date math is hydration-safe (no new Date() at client render).
  const today = new Date().toISOString().slice(0, 10);

  const [ideas, drafts] = await Promise.all([
    listPostIdeasForOrg(org.id, undefined, platform),
    // Include 'published' so the studio's "Posted" filter actually shows posted
    // items (the default draft+ready set excluded them, so Mark-as-posted made a
    // post vanish from every tab). Draft/Ready/Posted client filters split them.
    listPostDraftsForOrg(org.id, ["draft", "ready", "published"], platform),
  ]);
  // Media is only needed on its own tab. Uploaded media (content_media) +
  // content-pipeline's clips (external-media) form one unified library;
  // external clips are platform-agnostic, so always included.
  const media: MediaRow[] =
    section === "media"
      ? [...(await listContentMediaForOrg(org.id, platform)), ...(await listExternalMedia())]
      : [];

  // Style picker inputs — only the Drafts studio shows it, and only when the org
  // has a LinkedIn intern with ingested style sources (the corpus is LinkedIn).
  let style: Extract<WorkspaceData, { kind: "text" }>["style"] = null;
  if (section === "drafts") {
    const linkedin = (await listAgentInstancesForOrg(org.id)).find((i) => i.role === "linkedin_intern");
    if (linkedin) {
      const sources = await listFeederSources(linkedin.id);
      if (sources.length > 0) {
        style = {
          instanceId: linkedin.id,
          sources: sources.map((s) => ({ handle: s.handle, displayName: s.display_name })),
          pinnedStyleHandle:
            (linkedin.account_feeder_config as { pinnedStyleHandle?: string } | null | undefined)
              ?.pinnedStyleHandle ?? null,
        };
      }
    }
  }

  return {
    kind: "text",
    lane,
    orgSlug,
    section,
    platform,
    today,
    ideas,
    drafts,
    media,
    focusId: args.focusParam ?? null,
    // The Drafts nav badge counts the ACTIVE queue (draft + ready), not archived
    // posted items — otherwise including 'published' above would inflate it.
    counts: {
      ideas: ideas.filter((i) => i.status === "proposed").length,
      drafts: drafts.filter((d) => d.status !== "published").length,
    },
    style,
  };
}

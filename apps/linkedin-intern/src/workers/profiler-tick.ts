import { z } from "zod";
import type { Logger } from "../lib/logger.js";
import type { ActiveInstance } from "../lib/activation.js";
import type { ApifyLinkedInClient } from "@noelle/linkedin-apify";
import type { SpendRecorder } from "@noelle/runtime";
import { withMeteredApifyCall } from "@noelle/runtime/apify-metering";
import type { CodexRunner } from "../lib/codex-runner.js";
import type { ProfilePerson, WatchlistProfileUpsert } from "../lib/watchlist-db.js";
import { buildProfilerSystem } from "../lib/prompts.js";
import { linkedinInternRouting } from "../lib/routing.js";

const ProfilerOutput = z.object({
  summary: z.string().min(1),
  topics: z.array(z.string()).max(12).default([]),
  tone: z.string().default(""),
  engagement_notes: z.string().default(""),
});

// LinkedIn watchlist people post a lot, so the profiler does a DEEP read of their
// recent history (~40 posts) to build a well-grounded profile.
const DEFAULT_POST_LIMIT = 40;

export interface RunProfilerTickArgs {
  log: Logger;
  instance: ActiveInstance;
  /** People whose profile is missing/stale (from listWatchlistPeopleNeedingProfile). */
  people: ProfilePerson[];
  postsSource: Pick<ApifyLinkedInClient, "profilePosts" | "drainLastRunUsd" | "drainRunReceipts" | "isolateOperation">;
  runner: Pick<CodexRunner, "draft">;
  upsertProfile: (p: WatchlistProfileUpsert) => Promise<void>;
  /** Back-off marker for a person we tried but couldn't profile (no posts / parse fail / error). */
  markAttempted: (a: {
    orgId: string;
    agentInstanceId: string;
    fsdProfileId: string;
    publicId: string | null;
  }) => Promise<void>;
  postLimit?: number;
  /** Records the Apify spend of each profilePosts run (engine='apify'). Omit to skip. */
  recorder?: SpendRecorder;
  /** noelle.connections id of the token used, stamped on spend rows. */
  credentialId?: string | null;
}

export async function runProfilerTick(args: RunProfilerTickArgs): Promise<number> {
  const { log, instance, people, postsSource, runner, upsertProfile, markAttempted, recorder, credentialId } = args;
  const postLimit = args.postLimit ?? DEFAULT_POST_LIMIT;
  let profiled = 0;
  const backoff = (person: ProfilePerson) =>
    markAttempted({
      orgId: instance.org_id,
      agentInstanceId: instance.id,
      fsdProfileId: person.fsdProfileId,
      publicId: person.publicId,
    }).catch((err) =>
      log.warn({ fsdProfileId: person.fsdProfileId, err: (err as Error).message }, "markAttempted failed"),
    );

  for (const person of people) {
    try {
      if (!person.publicId) {
        log.warn(
          { fsdProfileId: person.fsdProfileId },
          "no public_id; cannot profile via Apify — backing off",
        );
        await backoff(person);
        continue;
      }
      const posts = await withMeteredApifyCall({ client: postsSource, recorder, log,
        orgId: instance.org_id, instanceId: instance.id, agentRole: "linkedin_intern",
        worker: "profiler", actor: "linkedin-profile-posts", startedAt: new Date(),
        credentialId: credentialId ?? null }, operation => operation.profilePosts({ publicId: person.publicId!, maxPosts: postLimit }));

      if (posts.length === 0) {
        // Nothing to read — back off (don't write an empty profile, but don't
        // re-fetch this dead profile every tick either).
        log.info({ fsdProfileId: person.fsdProfileId }, "no posts fetched; backing off profile");
        await backoff(person);
        continue;
      }

      const res = await runner.draft({
        bucket: "profiler-codex",
        routing: linkedinInternRouting(instance),
        orgId: instance.org_id,
        instanceId: instance.id,
        worker: "profiler",
        agentRole: "linkedin_intern",
        system: buildProfilerSystem(instance.objective),
        prompt: renderProfilerPrompt({
          name: person.name,
          publicId: person.publicId,
          posts: posts.map((p) => p.text),
        }),
      });

      const parsed = ProfilerOutput.safeParse(safeJsonParse(res.text));
      if (!parsed.success) {
        log.error(
          { fsdProfileId: person.fsdProfileId, raw: res.text.slice(0, 200) },
          "profiler output schema fail; backing off",
        );
        await backoff(person);
        continue;
      }

      await upsertProfile({
        orgId: instance.org_id,
        agentInstanceId: instance.id,
        fsdProfileId: person.fsdProfileId,
        publicId: person.publicId,
        summary: parsed.data.summary,
        topics: parsed.data.topics.slice(0, 6),
        tone: parsed.data.tone,
        engagementNotes: parsed.data.engagement_notes,
        postsAnalyzed: posts.length,
        model: res.model,
      });
      profiled++;
    } catch (err) {
      log.error(
        { fsdProfileId: person.fsdProfileId, err: (err as Error).message },
        "profiler tick failed for person; backing off",
      );
      await backoff(person);
    }
  }
  log.info({ profiled, candidates: people.length }, "profiler tick complete");
  return profiled;
}

function renderProfilerPrompt(args: { name: string | null; publicId: string | null; posts: string[] }): string {
  const who = args.name ?? args.publicId ?? "this LinkedIn person";
  return [
    `Profile this LinkedIn person: ${who}${args.publicId ? ` (linkedin.com/in/${args.publicId})` : ""}`,
    "",
    `Recent posts (${args.posts.length}), newest first:`,
    ...args.posts.map((t, i) => `[${i + 1}] ${t.replace(/\s+/g, " ").trim()}`),
    "",
    "Output the strict JSON profile object specified in the system prompt. First char `{`, last char `}`.",
  ].join("\n");
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  try {
    const stripped = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    return JSON.parse(stripped);
  } catch {
    /* fall through */
  }
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(s.slice(a, b + 1));
    } catch {
      /* fall through */
    }
  }
  return null;
}

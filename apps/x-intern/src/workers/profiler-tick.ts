import { z } from "zod";
import { type SpendRecorder } from "@noelle/runtime";
import { X_SCRAPER_ACTOR, type ApifyXClient } from "@noelle/x-apify";
import type { Logger } from "../lib/logger.js";
import type { ActiveInstance } from "../lib/activation.js";
import type { RateBucket } from "../lib/rate-bucket.js";
import type { CodexRunner } from "../lib/codex-runner.js";
import type { ProfilePerson, WatchlistProfileUpsert } from "../lib/profiles-db.js";
import { buildProfilerSystem } from "../lib/prompts.js";
import { xInternRouting } from "../lib/routing.js";
import { withMeteredApifyCall } from "../lib/apify-receipts.js";
import { AllApifyTokensExhaustedError } from "../lib/apify-rotating.js";

const ProfilerOutput = z.object({
  summary: z.string().min(1),
  topics: z.array(z.string()).max(12).default([]),
  tone: z.string().default(""),
  engagement_notes: z.string().default(""),
});

const DEFAULT_TWEET_LIMIT = 150;

export interface RunProfilerTickArgs {
  log: Logger;
  instance: ActiveInstance;
  /** People whose profile is missing/stale (from listWatchlistPeopleNeedingProfile). */
  people: ProfilePerson[];
  /** Read-only X client backed by Apify (see X_SCRAPER_ACTOR_ID in @noelle/x-apify). */
  xClient: Pick<ApifyXClient, "userTweets" | "drainLastRunUsd" | "drainRunReceipts" | "isolateOperation">;
  runner: Pick<CodexRunner, "draft">;
  upsertProfile: (p: WatchlistProfileUpsert) => Promise<void>;
  /** Back-off marker for a person we tried but couldn't profile (no tweets / parse fail / error). */
  markAttempted: (a: { orgId: string; agentInstanceId: string; handle: string }) => Promise<void>;
  rateBucket: RateBucket;
  tweetLimit?: number;
  /** Records Apify per-result spend (engine='apify'). Best-effort; no-op if absent. */
  recorder?: SpendRecorder;
  /** noelle.connections row id of the Apify token that paid, for per-token spend. */
  credentialId?: string | null;
}

export async function runProfilerTick(args: RunProfilerTickArgs): Promise<number> {
  const { log, instance, people, xClient, runner, upsertProfile, markAttempted, rateBucket, recorder } =
    args;
  const tweetLimit = args.tweetLimit ?? DEFAULT_TWEET_LIMIT;
  let profiled = 0;
  const backoff = (handle: string) =>
    markAttempted({ orgId: instance.org_id, agentInstanceId: instance.id, handle }).catch(
      (err) => log.warn({ handle, err: (err as Error).message }, "markAttempted failed"),
    );

  for (const person of people) {
    if (!rateBucket.tryTake()) {
      log.warn({ handle: person.handle }, "rate bucket empty; deferring profile this tick");
      continue;
    }
    try {
      const { tweets } = await withMeteredApifyCall({
        client: xClient, recorder, log,
        orgId: instance.org_id, instanceId: instance.id, agentRole: "x_intern",
        worker: "profiler", actor: X_SCRAPER_ACTOR, startedAt: new Date(),
        credentialId: args.credentialId ?? null,
      }, operation => operation.userTweets({ handle: person.handle, limit: tweetLimit }));
      if (tweets.length === 0) {
        // Nothing to read — back off (don't write an empty profile, but don't
        // re-fetch this dead handle every tick either).
        log.info({ handle: person.handle }, "no tweets fetched; backing off profile");
        await backoff(person.handle);
        continue;
      }

      const res = await runner.draft({
        bucket: "profiler-codex",
        routing: xInternRouting(instance),
        orgId: instance.org_id,
        instanceId: instance.id,
        worker: "profiler",
        agentRole: "x_intern",
        system: buildProfilerSystem(instance.objective),
        prompt: renderProfilerPrompt({ handle: person.handle, tweets: tweets.map((t) => t.text) }),
      });

      const parsed = ProfilerOutput.safeParse(safeJsonParse(res.text));
      if (!parsed.success) {
        log.error(
          { handle: person.handle, raw: res.text.slice(0, 200) },
          "profiler output schema fail; backing off",
        );
        await backoff(person.handle);
        continue;
      }

      await upsertProfile({
        orgId: instance.org_id,
        agentInstanceId: instance.id,
        handle: person.handle,
        summary: parsed.data.summary,
        topics: parsed.data.topics.slice(0, 6),
        tone: parsed.data.tone,
        engagementNotes: parsed.data.engagement_notes,
        postsAnalyzed: tweets.length,
        model: res.model,
      });
      profiled++;
    } catch (err) {
      if (err instanceof AllApifyTokensExhaustedError) throw err;
      log.error(
        { handle: person.handle, err: (err as Error).message },
        "profiler tick failed for person; backing off",
      );
      await backoff(person.handle);
    }
  }
  log.info({ profiled, candidates: people.length }, "profiler tick complete");
  return profiled;
}

function renderProfilerPrompt(args: { handle: string; tweets: string[] }): string {
  return [
    `Profile this X account: @${args.handle}`,
    "",
    `Recent tweets (${args.tweets.length}), newest first:`,
    ...args.tweets.map((t, i) => `[${i + 1}] ${t.replace(/\s+/g, " ").trim()}`),
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

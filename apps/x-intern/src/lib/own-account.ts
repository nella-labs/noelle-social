/**
 * Own-account measurements stored in the shared memory bus and rendered as
 * explicit known or unknown facts for reply and direct-message drafts.
 */

import type { Bus } from "@noelle/runtime";
import { readXSourceCount, readXSourceTimestamp } from "@noelle/x-client";

/** Bus KV namespace + key for the operator's own-account snapshot. */
export const OWN_ACCOUNT_BUCKET = "own_account";
export const OWN_ACCOUNT_KEY_X = "x";

/**
 * A measurement of the operator's own account at a point in time. Every count
 * is nullable on purpose: "unknown" and "zero" are different claims, and the
 * drafter is allowed to say the number out loud, so a null must never render as
 * a 0.
 */
export interface OwnAccountSnapshot {
  handle: string;
  followers: number | null;
  following: number | null;
  posts: number | null;
  /** ISO-8601. When the measurement was taken, NOT when it was written. */
  capturedAt: string;
  /** Which read path produced it — for debugging a wrong number later. */
  source: "x_api" | "apify";
}

/**
 * How old a snapshot may be and still be handed to the drafter as fact.
 *
 * Counts older than this limit are unknown for drafting purposes because the
 * account may have changed since the measurement.
 */
export const OWN_ACCOUNT_MAX_AGE_DAYS = 3;

function savedCount(value: unknown): number | null {
  // The bus stores numeric counts; text and fractional values are not measurements.
  return typeof value === "number" && Number.isInteger(value) ? readXSourceCount(value) : null;
}

/**
 * Parse a bus value into a snapshot. Returns null for anything malformed — a
 * corrupt row must degrade to "no facts" (which is safe: the prompt still bans
 * inventing), never throw into the drafter tick.
 */
export function parseOwnAccountSnapshot(value: unknown): OwnAccountSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const handle = typeof v["handle"] === "string" ? v["handle"].trim().replace(/^@/, "") : "";
  const capturedAt = readXSourceTimestamp(v["capturedAt"]);
  if (!handle || !capturedAt) return null;
  const source = v["source"] === "apify" ? "apify" : "x_api";
  return {
    handle,
    followers: savedCount(v["followers"]),
    following: savedCount(v["following"]),
    posts: savedCount(v["posts"]),
    capturedAt,
    source,
  };
}

/** Age of a snapshot in whole-ish days (fractional), or Infinity if unparseable. */
export function snapshotAgeDays(snap: OwnAccountSnapshot, now: Date): number {
  const capturedAt = readXSourceTimestamp(snap.capturedAt);
  if (!capturedAt) return Number.POSITIVE_INFINITY;
  const t = Date.parse(capturedAt);
  return (now.getTime() - t) / 86_400_000;
}

/** Read the latest own-account snapshot off the bus. Fail-soft → null. */
export async function readOwnAccountSnapshot(bus: Bus): Promise<OwnAccountSnapshot | null> {
  try {
    // bus.get returns the stored VALUE (already JSON-parsed), not a row wrapper.
    return parseOwnAccountSnapshot(await bus.get(OWN_ACCOUNT_BUCKET, OWN_ACCOUNT_KEY_X));
  } catch {
    return null;
  }
}

/** Write a snapshot to the bus. `bus.put` is already fail-soft (never throws). */
export async function writeOwnAccountSnapshot(
  bus: Bus,
  snap: OwnAccountSnapshot,
  worker: string,
): Promise<void> {
  await bus.put(OWN_ACCOUNT_BUCKET, OWN_ACCOUNT_KEY_X, { ...snap }, { worker });
}

/**
 * Render the drafter's YOUR OWN ACCOUNT block.
 *
 * This ALWAYS returns a block, even with no snapshot — that is the point. The
 * failure mode being fixed is the model filling a gap it did not know was a
 * gap, so the absence of a number has to be stated as loudly as its presence.
 * A stale snapshot is treated as no snapshot for the count itself.
 */
export function renderOwnAccountBlock(snap: OwnAccountSnapshot | null, now: Date): string {
  const lines = ["YOUR OWN ACCOUNT (ground truth about the operator — the ONLY self-numbers you may state)"];
  const normalized = parseOwnAccountSnapshot(snap);
  const age = normalized ? snapshotAgeDays(normalized, now) : Number.POSITIVE_INFINITY;
  const fresh = normalized && age >= 0 && age <= OWN_ACCOUNT_MAX_AGE_DAYS ? normalized : null;

  if (fresh) {
    const facts: string[] = [`@${fresh.handle}`];
    if (fresh.followers != null) facts.push(`${fresh.followers.toLocaleString("en-US")} followers`);
    if (fresh.following != null) facts.push(`following ${fresh.following.toLocaleString("en-US")}`);
    if (fresh.posts != null) facts.push(`${fresh.posts.toLocaleString("en-US")} posts`);
    lines.push(`Measured ${describeAge(age)}: ${facts.join(", ")}.`);
    lines.push(
      "These numbers move. Only say one out loud when the post genuinely calls for it, and use the number above exactly, never a rounded or remembered one.",
    );
  } else if (normalized && age < 0) {
    lines.push("The measurement timestamp is ahead of the current clock. Treat every count as unknown.");
  } else if (normalized) {
    lines.push(
      `The last measurement of @${normalized.handle} is ${describeAge(age)} old, so it is no longer accurate. Treat every count as unknown.`,
    );
  } else {
    lines.push("No current measurement of the operator's account is available. Treat every count as unknown.");
  }

  lines.push(
    "You do NOT know any self-number that is not listed above: not followers, impressions, revenue, MRR, users, signups, streak length, or how long you have been building. Never estimate, guess, or invent one, not even as a throwaway aside or a self-deprecating joke, and never round one you were not given. Do not replace an unknown number with an unsupported qualitative claim such as \"barely anyone follows me\". Write without a self-stat or pick a different thing to say (\"24 followers\" is not allowed unless measured above).",
  );
  return lines.join("\n");
}

/** "just now" / "4 hours ago" / "6 days ago" — enough for the model to weigh it. */
function describeAge(days: number): string {
  if (!Number.isFinite(days)) return "an unknown time";
  const hours = days * 24;
  if (hours < 1) return "just now";
  if (hours < 36) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"} ago`;
  return `${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"} ago`;
}

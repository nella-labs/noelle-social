import { describe, expect, it } from "vitest";
import { buildProfilerQueue } from "./profiler-queue.js";
import type { ProfilePerson, RepliedProfileCandidate } from "./watchlist-db.js";

const watched = (fsdProfileId: string, publicId: string | null = null): ProfilePerson => ({
  fsdProfileId,
  publicId,
  name: null,
  headline: null,
});

const replied = (
  fsdProfileId: string,
  publicId: string | null,
  postUrl: string | null = null,
  replies = 9,
): RepliedProfileCandidate => ({ fsdProfileId, publicId, name: null, headline: null, postUrl, replies });

describe("buildProfilerQueue", () => {
  it("puts watchlist people first, then high-reply authors", () => {
    const out = buildProfilerQueue({
      watchlist: [watched("alice")],
      replied: [replied("bob", "bob")],
      batch: 5,
    });
    expect(out.map((x) => x.fsdProfileId)).toEqual(["alice", "bob"]);
  });

  it("recovers the vanity slug when the stored public id is a member urn", () => {
    // Without this the profiler backs off with "no public_id" — profilePosts is
    // keyed on linkedin.com/in/<slug> and a urn is not a slug.
    const out = buildProfilerQueue({
      watchlist: [],
      replied: [
        replied(
          "ACwAABlDYv4BnnBKfPQRpeO8bEiD6KWZWZw7Z2s",
          "ACwAABlDYv4BnnBKfPQRpeO8bEiD6KWZWZw7Z2s",
          "https://www.linkedin.com/posts/pallifrone_as-long-as-activity-7473904945554038784-o29i",
          17,
        ),
      ],
      batch: 5,
    });
    expect(out[0]!.publicId).toBe("pallifrone");
    // The fsd key is untouched — it addresses the profile ROW, not the fetch.
    expect(out[0]!.fsdProfileId).toBe("ACwAABlDYv4BnnBKfPQRpeO8bEiD6KWZWZw7Z2s");
  });

  it("dedupes the same human reaching both lanes under different ids", () => {
    // Watchlist rows are keyed by member urn; leads by the vanity slug. Kaia is
    // one person, one profile row, and must cost one fetch.
    const out = buildProfilerQueue({
      watchlist: [watched("ACoAAFX4vD8BaZrzmCr01DbMFhT1VdnWcYePU94", "kaia-tham")],
      replied: [replied("ACoAAFX4vD8BaZrzmCr01DbMFhT1VdnWcYePU94", "kaia-tham"), replied("nic", "nic")],
      batch: 5,
    });
    expect(out.map((x) => x.fsdProfileId)).toEqual([
      "ACoAAFX4vD8BaZrzmCr01DbMFhT1VdnWcYePU94",
      "nic",
    ]);
  });

  it("dedupes on the slug alone when the two lanes disagree on the fsd key", () => {
    const out = buildProfilerQueue({
      watchlist: [watched("ACoAAFX4vD8BaZrzmCr01DbMFhT1VdnWcYePU94", "kaia-tham")],
      replied: [replied("kaia-tham", "kaia-tham")],
      batch: 5,
    });
    expect(out).toHaveLength(1);
  });

  it("caps at batch, and the watchlist never gets starved by the reply tail", () => {
    const out = buildProfilerQueue({
      watchlist: [watched("alice")],
      replied: [replied("b", "b"), replied("c", "c"), replied("d", "d")],
      batch: 3,
    });
    expect(out.map((x) => x.fsdProfileId)).toEqual(["alice", "b", "c"]);
  });

  it("returns [] when the batch is zero", () => {
    expect(buildProfilerQueue({ watchlist: [watched("a")], replied: [], batch: 0 })).toEqual([]);
  });
});

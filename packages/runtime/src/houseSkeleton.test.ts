import { describe, it, expect } from "vitest";
import { houseSkeletonHits, NO_HOUSE_SKELETON_RULE } from "./houseSkeleton.js";
import { scoreFormat } from "./drafting/draftVerifier.js";

const reply = (body: string) => ({ kind: "reply" as const, angle: null, body });
const dm = (body: string) => ({ kind: "dm" as const, angle: null, body });

// Every string here is a REAL draft Lyra or Vega queued in the last 30 days.
const LIVE_SKELETONS = [
  "the brothers-as-cofounders line is the one i keep chewing on",
  "gm posts are the part i'd cut. i showed up daily for a while",
  "the trust ranking is the bit i'd fight, since a regulator picks it apart",
  "the domain purchase is the step i keep snagging on",
  "named ownership per skill is the line i keep coming back to",
  "the 73% human score on a telegram account is the detail i keep re-reading",
  "the $0/hour line is doing a lot of work here",
  "the sophistication level 4 framing is doing most of the work",
  "less than 1% posting is the whole moat lol",
  "a Red Bull and a VOSS on marble at 12:28am is the least glamorous thing",
  "the arms-up photo says more about resilience than the list does",
];

// Sentences that share vocabulary with the frames but are NOT the skeleton:
// the subject is the operator or the world, not a graded detail of the post.
const CLEAN = [
  "i swapped the linker for mold and my link step halved",
  "my own queue backs up at the approval step every time",
  "i'd hold off on the 50% until someone outside the repo measures it",
  "what did they say that made you rip up the core flow?",
  "mine still agrees with all my bad ideas",
  "one part of me wants to rip the whole thing out and start again",
  "i ran cold paid with zero organic proof once and burned the budget",
  "polling a completion flag works until agent A dies after writing it",
];

describe("houseSkeletonHits", () => {
  it("catches every canned frame from the live corpus", () => {
    for (const body of LIVE_SKELETONS) {
      expect(houseSkeletonHits(body), body).not.toHaveLength(0);
    }
  });

  it("leaves first-person and world-subject sentences alone", () => {
    for (const body of CLEAN) {
      expect(houseSkeletonHits(body), body).toHaveLength(0);
    }
  });

  it.each([
    "I was the only engineer on call when the migration failed.",
    "We were the only team assigned to the migration.",
  ])("keeps a factual first-person staffing clause: %s", (body) => {
    expect(houseSkeletonHits(body)).toEqual([]);
    expect(scoreFormat(reply(body), 250).score).toBe(1);
  });

  it.each([
    "I think their pricing is the real bottleneck.",
    "I was the only engineer on call. Their pricing is the real bottleneck.",
    "We were the only team assigned to the migration, and their dashboard is the hardest part.",
    "I was the only genius in the room.",
  ])("retains the grading guard around first-person words: %s", (body) => {
    expect(houseSkeletonHits(body).length).toBeGreaterThan(0);
  });

  it("names the positive rewrite, not just the ban", () => {
    const [label] = houseSkeletonHits("the trust ranking is the bit i'd fight");
    expect(label!.toLowerCase()).toMatch(/rewrite|instead|say what|replace/);
  });

  it("the prompt rule states the ban, the structure, and the alternative", () => {
    expect(NO_HOUSE_SKELETON_RULE).toContain("NEVER GRADE THEIR DETAIL");
    expect(NO_HOUSE_SKELETON_RULE).toContain("STRUCTURAL");
    expect(NO_HOUSE_SKELETON_RULE.toLowerCase()).toContain("instead");
  });
});

describe("scoreFormat — house skeleton penalty", () => {
  it("drops a clean-but-skeletal reply below the 0.7 pass bar", () => {
    const f = scoreFormat(reply("the trust ranking is the bit i'd fight"), 250);
    expect(f.score).toBeLessThan(0.7);
    expect(f.reasons.join(" ")).toContain("house skeleton");
  });

  it("stacks when a draft runs two frames", () => {
    const one = scoreFormat(reply("the trust ranking is the bit i'd fight"), 250).score;
    const two = scoreFormat(
      reply("the trust ranking is the bit i'd fight and the pricing is doing a lot of the work"),
      250,
    ).score;
    expect(two).toBeLessThan(one);
  });

  it("is not a hard zero — a single frame can still survive best-of-set", () => {
    expect(scoreFormat(reply("the trust ranking is the bit i'd fight"), 250).score).toBeGreaterThan(0);
  });

  it("never fires on a DM", () => {
    const f = scoreFormat(dm("the trust ranking is the bit i'd fight"), 900);
    expect(f.reasons.join(" ")).not.toContain("house skeleton");
    expect(f.score).toBe(1);
  });

  it("leaves a clean reply at 1.0", () => {
    expect(scoreFormat(reply("i swapped the linker for mold and my link step halved"), 250).score).toBe(1);
  });
});

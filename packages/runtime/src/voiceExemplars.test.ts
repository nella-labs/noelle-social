import { describe, expect, it } from "vitest";
import { renderVoiceExemplars } from "./voiceExemplars.js";

const ex = [
  { post: "90 days building in public. ~250 posts and 4000 replies.", reply: "4000 replies to 250 posts is a 16:1 ratio i'm stealing straight into my week" },
  { post: "Launching on iMessage, built in a single afternoon.", reply: "an iMessage surface in one afternoon is the part i want the writeup for" },
];

describe("renderVoiceExemplars", () => {
  it("pairs each reply with the post it answered", () => {
    // The pairing IS the feature: an orphan reply cannot show what the reply
    // did with the post, which is the move the drafter was missing.
    const out = renderVoiceExemplars(ex);
    expect(out).toContain("POST: 90 days building in public");
    expect(out).toContain("YOU REPLIED: 4000 replies to 250 posts");
    expect(out.indexOf("POST: 90 days")).toBeLessThan(out.indexOf("YOU REPLIED: 4000 replies"));
  });

  it("restates the no-lifting rule — pairs pull harder toward copying than snippets", () => {
    const out = renderVoiceExemplars(ex);
    expect(out).toMatch(/never lift a phrase/i);
    expect(out).toMatch(/no sense under any post except/i);
  });

  it("renders nothing at all when there are no approved replies yet", () => {
    // A new org has no sent history; an empty header would be noise in the
    // prompt and cost tokens for nothing.
    expect(renderVoiceExemplars([])).toBe("");
  });

  it("truncates a long post but never the reply", () => {
    const long = "x".repeat(2000);
    const reply = "y".repeat(400);
    const out = renderVoiceExemplars([{ post: long, reply }]);
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(1200);
    expect(out).toContain(reply);
  });

  it("keeps the opening and a late post detail that explains the full reply", () => {
    const opening = "We rebuilt onboarding after the first cohort stalled.";
    const post = `${opening} ${"The team tried another generic experiment. ".repeat(10)}Retention fell to 17 percent after the handoff to sales. ${"More notes followed. ".repeat(30)}`;
    const reply = "the 17 percent retention drop after the sales handoff is the bit i'd want to debug first";
    const out = renderVoiceExemplars([{ post, reply }]);
    const postLine = out.split("\n").find((line) => line.startsWith("POST: "))!;

    expect(post.indexOf("17 percent")).toBeGreaterThan(280);
    expect(postLine).toContain(opening);
    expect(postLine).toContain("17 percent after the handoff to sales");
    expect(postLine.length).toBeLessThanOrEqual("POST: ".length + 280);
    expect(out).toContain(`YOU REPLIED: ${reply}`);
  });

  it("stays within the post budget when the opening has no space", () => {
    const post = `${"x".repeat(300)} a late anchor for the reply ${"y".repeat(300)}`;
    const out = renderVoiceExemplars([{ post, reply: "that late anchor matters" }]);
    const postLine = out.split("\n").find((line) => line.startsWith("POST: "))!;

    expect(postLine).toContain("late anchor");
    expect(postLine.length).toBeLessThanOrEqual("POST: ".length + 280);
  });

  it("retains a reply anchor starting at the last omitted character", () => {
    const prefix = `Start ${"f".repeat(272)} `;
    const out = renderVoiceExemplars([{
      post: `${prefix}anchor detail ${"more context ".repeat(30)}`,
      reply: "the anchor is the whole story",
    }]);
    const postLine = out.split("\n").find((line) => line.startsWith("POST: "))!;

    expect(prefix.length).toBe(279);
    expect(postLine).toContain("anchor detail");
    expect(postLine.length).toBeLessThanOrEqual("POST: ".length + 280);
  });

  it("collapses whitespace so a multi-line post stays one POST line", () => {
    const out = renderVoiceExemplars([{ post: "line one\n\n  line two", reply: "ok" }]);
    expect(out).toContain("POST: line one line two");
  });
});

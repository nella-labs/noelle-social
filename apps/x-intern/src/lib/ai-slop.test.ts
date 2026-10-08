import { describe, expect, it } from "vitest";
import { detectAiSlop, AI_SLOP_CUTOFF } from "./ai-slop.js";

describe("detectAiSlop", () => {
  it("flags the launch-post slop from the screenshot", () => {
    // The post that triggered this feature: emoji section markers, em-dashes,
    // 'Building in public', reframe-ish hype. Classic LLM launch slop.
    const text =
      "People keep asking what I'm actually building. Here it is, as simply as I can put it: " +
      "AI agents are everywhere now — they write code, handle tasks, do real work. But three things " +
      "are missing for them: they can't earn, they can't easily get better, and you can't tell which " +
      "ones are any good. 🧩 /code — agents publish code that other agents pay to use. " +
      "🛠 /forge — an agent finds the skill it's missing and equips it on the spot. " +
      "🔬 the science — TLC is also the first place to actually measure whether AI behaves well. " +
      "Built mostly solo. Still early, still mostly empty. But it runs, and it's live. Building in public 🛠";
    const r = detectAiSlop(text);
    expect(r.isSlop).toBe(true);
    expect(r.score).toBeGreaterThan(AI_SLOP_CUTOFF);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("flags negative parallelism / reframe (the heaviest tell)", () => {
    const r = detectAiSlop("It's not a tool. It's a system. The question isn't how, it's why.");
    expect(r.isSlop).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/reframe|parallel/i);
  });

  it("flags a buzzword-dense corporate post", () => {
    const r = detectAiSlop(
      "Our seamless, robust platform lets you leverage cutting-edge AI to unlock " +
        "frictionless, game-changing workflows and supercharge your productivity.",
    );
    expect(r.isSlop).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/hype|buzzword/i);
  });

  it("flags emoji-as-bullets launch posts", () => {
    const r = detectAiSlop(
      "Shipping today:\n🚀 faster builds\n✨ cleaner UI\n🔒 better security\n🎯 sharper focus",
    );
    expect(r.reasons.join(" ")).toMatch(/emoji/i);
  });

  it("does NOT flag a normal human question", () => {
    const r = detectAiSlop(
      "anyone know a good way to run postgres migrations in a turbo monorepo? " +
        "drizzle keeps fighting me on the generated sql",
    );
    expect(r.isSlop).toBe(false);
    expect(r.score).toBeLessThan(AI_SLOP_CUTOFF);
  });

  it("does NOT flag a short specific human take", () => {
    const r = detectAiSlop("spent 3 hours today debugging a hydration bug. it was a Date.now() in a client component lol");
    expect(r.isSlop).toBe(false);
  });

  it("does NOT flag a single buzzword in otherwise-human text", () => {
    // One hype word is not slop — it takes a combination of tells.
    const r = detectAiSlop("just shipped a robust little cli tool for my own workflow, pretty happy with it");
    expect(r.isSlop).toBe(false);
  });

  it("returns score 0 and not-slop for empty text", () => {
    const r = detectAiSlop("");
    expect(r.score).toBe(0);
    expect(r.isSlop).toBe(false);
  });

  it("flags mass @-mention tagging bait", () => {
    const r = detectAiSlop(
      "A message to @YouTubeCreators @TeamYouTube @nealmohan @reneritchie and every YouTuber. " +
        "Congrats to @EternalMystYT @mansterzs @AydinPaladin and @siniviere for winning your battles.",
    );
    expect(r.isSlop).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/mention/i);
  });

  it("counts a repeated handle once across punctuation and case", () => {
    const r = detectAiSlop("@Same,@same;@SAME!@same?@Same");
    expect(r.isSlop).toBe(false);
    expect(r.score).toBe(0);
    expect(r.reasons).toEqual([]);
  });

  it("still flags five distinct handles as mass-mention bait", () => {
    const r = detectAiSlop("@one,@two;@three!@four?@five");
    expect(r.isSlop).toBe(true);
    expect(r.score).toBe(0.6);
    expect(r.reasons).toContain("mass-mention bait x5");
  });

  it("flags hashtag stuffing (3+)", () => {
    const r = detectAiSlop("Big update on the project today. #RussiaUkraineWar #RussianWarCrimes #Ukraine");
    expect(r.isSlop).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/hashtag/i);
  });

  it("flags the Dnipro news report (news emoji + war hashtags)", () => {
    const r = detectAiSlop(
      "💥 In Dnipro, on the night of April 16, a Russian ballistic missile strike destroyed the apartment " +
        "of photojournalist Mykola Koshelev. He told this to IMI. The family lost all their belongings. " +
        "#RussiaUkraineWar #RussianWarCrimes #Ukraine",
    );
    expect(r.isSlop).toBe(true);
  });

  it("flags the mass-tag YouTube demonetization rant", () => {
    const r = detectAiSlop(
      "A message to @YouTubeCreators @TeamYouTube @nealmohan @reneritchie and every YouTuber that suffers. " +
        "Please comment, share, and tag YouTube. And a big thank you to @Nina7Infinity @verbalriotshow " +
        "@thevivafrei @Kneon @MeganFoxWriter @hunleyeric @bear_ing @DisaffectedPod for your support. " +
        "#youtube #inauthentic #AI",
    );
    expect(r.isSlop).toBe(true);
  });

  it("does NOT flag a normal post with one hashtag and one mention", () => {
    const r = detectAiSlop("shipping a small fix today, thanks @someone for the bug report #buildinpublic");
    expect(r.isSlop).toBe(false);
  });
});

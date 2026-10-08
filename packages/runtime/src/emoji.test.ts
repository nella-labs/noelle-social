import { describe, expect, it } from "vitest";
import { stripDisallowedEmoji, hasEmoji, applyReplyEmojiPolicy } from "./emoji.js";

describe("stripDisallowedEmoji", () => {
  it("keeps the three allowed emoji", () => {
    expect(stripDisallowedEmoji("this is brutal 💀")).toBe("this is brutal 💀");
    expect(stripDisallowedEmoji("i felt that 😭")).toBe("i felt that 😭");
    expect(stripDisallowedEmoji("lol 😛")).toBe("lol 😛");
  });

  it("strips every other emoji", () => {
    expect(stripDisallowedEmoji("huge win 🚀")).toBe("huge win");
    expect(stripDisallowedEmoji("congrats 🎉 🙌 👏")).toBe("congrats");
    expect(stripDisallowedEmoji("ship it 🔥✅💡")).toBe("ship it");
  });

  it("strips disallowed but keeps allowed in the same string", () => {
    expect(stripDisallowedEmoji("rough week 😭 but we shipped 🚀")).toBe(
      "rough week 😭 but we shipped",
    );
  });

  it("removes ZWJ sequences and skin-tone modifiers whole (no orphan halves)", () => {
    expect(stripDisallowedEmoji("team 👨‍👩‍👧 hi")).toBe("team hi");
    expect(stripDisallowedEmoji("nice 👍🏽 work")).toBe("nice work");
  });

  it("drops a variation selector on an allowed emoji but keeps the base", () => {
    expect(stripDisallowedEmoji("dead 💀️")).toBe("dead 💀");
  });

  it("does not collapse newlines (DM bodies are multi-chunk)", () => {
    expect(stripDisallowedEmoji("hey\n\nthat's wild 🚀\n\nlmk")).toBe(
      "hey\n\nthat's wild\n\nlmk",
    );
  });

  it("tidies the space a removed emoji leaves before punctuation", () => {
    expect(stripDisallowedEmoji("that's wild 🚀, honestly")).toBe(
      "that's wild, honestly",
    );
  });

  it("leaves emoji-free text untouched", () => {
    const t = "no emoji here, just a normal comment about indexing";
    expect(stripDisallowedEmoji(t)).toBe(t);
  });

  it.each(["🇨🇴", "🇺🇸", "1️⃣", "#️⃣", "*⃣", "🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}"])(
    "strips the complete flag or keycap %s without leftover codepoints", (emoji) => {
      expect(stripDisallowedEmoji(`before ${emoji} after`)).toBe("before after");
      expect(stripDisallowedEmoji(`before ${emoji} after`, { postText: "plain post" })).toBe("before after");
      expect(applyReplyEmojiPolicy([{ body: emoji }], "plain post")).toEqual([]);
    });

  it("preserves plain numbers and punctuation while recognizing keycap emoji", () => {
    expect(stripDisallowedEmoji("1 # * 42")).toBe("1 # * 42");
    expect(hasEmoji("1 # * 42")).toBe(false);
    expect(hasEmoji("choice 1️⃣")).toBe(true);
    expect(stripDisallowedEmoji("rough 💀", { postText: "choice 1️⃣" })).toBe("rough 💀");
  });
});

describe("stripDisallowedEmoji — the MATCH THE POST half of the rule", () => {
  // The product rule always had two clauses: an emoji only when the post itself
  // uses one, AND only from the allowlist. Only the allowlist half had a
  // deterministic backstop. A real draft caught in review put 💀 under a post
  // with no emoji in it at all.
  const POST_NO_EMOJI = "my agent opened a PR to fix a bug and it introduced two more";
  const POST_WITH_EMOJI = "my agent opened a PR to fix a bug 💀 and it introduced two more";

  it("strips an ALLOWLISTED emoji when the post has none", () => {
    expect(stripDisallowedEmoji("free energy, just add compute 💀", { postText: POST_NO_EMOJI }))
      .toBe("free energy, just add compute");
  });

  it("keeps an allowlisted emoji when the post uses emoji", () => {
    expect(stripDisallowedEmoji("free energy, just add compute 💀", { postText: POST_WITH_EMOJI }))
      .toBe("free energy, just add compute 💀");
  });

  it("still strips a NON-allowlisted emoji even when the post uses emoji", () => {
    expect(stripDisallowedEmoji("shipping it 🚀", { postText: POST_WITH_EMOJI })).toBe("shipping it");
  });

  it("counts a non-allowlisted emoji in the POST as the post using emoji", () => {
    // The gate is "did they set an emoji register", not "did they use one of
    // ours" — answering a 🚀 post with 💀 is in register.
    expect(stripDisallowedEmoji("brutal 💀", { postText: "we shipped 🚀" })).toBe("brutal 💀");
  });

  it("omitting postText keeps the old allowlist-only behaviour exactly", () => {
    expect(stripDisallowedEmoji("dead 💀")).toBe("dead 💀");
    expect(stripDisallowedEmoji("dead 💀", {})).toBe("dead 💀");
    expect(stripDisallowedEmoji("dead 💀", { postText: null })).toBe("dead 💀");
  });

  it("does NOT treat ordinary typography as the post using emoji", () => {
    // \p{Extended_Pictographic} alone matches ™ © ® ‼ ↔ ♥ ✔, which appear in
    // perfectly emoji-free prose. Using it as the gate meant "Acme™ just
    // shipped v2" read as setting an emoji register, which re-opened the exact
    // hole the postText gate was added to close.
    for (const post of ["Acme™ just shipped v2", "(c) 2026 ©", "5 ↔ 6", "I ♥ this", "done ✔", "Reg® mark"]) {
      expect(hasEmoji(post), post).toBe(false);
      expect(stripDisallowedEmoji("brutal 💀", { postText: post }), post).toBe("brutal");
    }
  });

  it("DOES treat real emoji as the post using emoji, presentation or selector", () => {
    for (const post of ["we shipped 🚀", "lol 😭", "brutal 💀", "done ✔️", "heart ❤️"]) {
      expect(hasEmoji(post), post).toBe(true);
      expect(stripDisallowedEmoji("brutal 💀", { postText: post }), post).toBe("brutal 💀");
    }
  });

  it("hasEmoji does not carry regex lastIndex between calls", () => {
    // EMOJI_GRAPHEME is a /g/ regex; testing it directly would alternate
    // true/false on repeated calls with the same input.
    for (let i = 0; i < 6; i++) {
      expect(hasEmoji("we shipped 🚀")).toBe(true);
      expect(hasEmoji("we shipped")).toBe(false);
    }
  });
});

describe("applyReplyEmojiPolicy", () => {
  const NO_EMOJI_POST = "third week the deploy passed CI and broke prod";
  const R = (d: { kind?: string }) => d.kind === "reply";

  it("drops the bodies the gate empties, keeping the rest", () => {
    const out = applyReplyEmojiPolicy(
      [{ body: "\u{1F480}" }, { body: "green CI just means the doubles agreed" }],
      NO_EMOJI_POST,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toBe("green CI just means the doubles agreed");
  });

  it("rescues ONE reply rather than returning nothing when the gate empties them all", () => {
    const out = applyReplyEmojiPolicy(
      [{ body: "\u{1F480}" }, { body: "\u{1F62D}" }],
      NO_EMOJI_POST,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.body.trim().length).toBeGreaterThan(0);
  });

  it("returns [] when even the RESCUE is empty", () => {
    // The rescue re-strips with allowlist-only rules, so a body that is only a
    // NON-allowlisted emoji has nothing left either. Returning it anyway made
    // every caller's `length === 0` guard dead code: the array was length 1
    // with an empty body inside, so body.min(1) threw downstream exactly as if
    // there were no guard at all.
    expect(applyReplyEmojiPolicy([{ body: "\u{1F389}" }], NO_EMOJI_POST)).toEqual([]);
    const out = applyReplyEmojiPolicy(
      [{ body: "\u{1F389}" }, { body: "\u{1F680}" }],
      NO_EMOJI_POST,
    );
    expect(out).toEqual([]);
  });

  it("never returns a draft with an empty body, swept", () => {
    const bodies = ["\u{1F389}", "\u{1F480}", "\u{1F680}\u{1F389}", "real take", "  ", ""];
    for (const a of bodies) {
      for (const b of bodies) {
        for (const post of [NO_EMOJI_POST, "we shipped \u{1F680}"]) {
          for (const d of applyReplyEmojiPolicy([{ body: a }, { body: b }], post)) {
            expect(d.body.trim().length, `${a}|${b}|${post}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("rescues on the REPLY rows, not on the set — a DM must not mask an empty reply", () => {
    // The rescue used to key on the whole set being empty. A DM is exempt from
    // the post-match clause, so a lead whose replies all cleaned to nothing but
    // which carries a DM left kept = [dmRow] — non-empty, rescue skipped, lead
    // marked drafted with a DM and no public comment at all.
    const out = applyReplyEmojiPolicy(
      [
        { kind: "reply", body: "\u{1F480}" },
        { kind: "dm", body: "hey there" },
      ],
      NO_EMOJI_POST,
      R,
    );
    expect(out.some((d) => d.kind === "reply")).toBe(true);
    expect(out.some((d) => d.kind === "dm")).toBe(true);
  });

  it("honours the isReply predicate so DMs keep allowlist-only stripping", () => {
    const out = applyReplyEmojiPolicy(
      [
        { kind: "reply", body: "brutal \u{1F480}" },
        { kind: "dm", body: "hey \u{1F480}" },
      ],
      NO_EMOJI_POST,
      R,
    );

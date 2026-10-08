import { describe, it, expect, vi } from "vitest";
import { clearFocusedEditor, makeNavigateTab, runClearComposer, sameDraft, type ClearComposerDeps } from "./clear-composer.js";

const noSleep = async (_ms: number) => {};

describe("clearFocusedEditor", () => {
  it("applies selectAll then deleteBackward as editing commands", async () => {
    const calls: Record<string, unknown>[] = [];
    const send = async (_t: number, _m: string, p?: object) => {
      calls.push((p ?? {}) as Record<string, unknown>);
      return undefined;
    };
    await clearFocusedEditor(send, 7, noSleep);
    const commands = calls.flatMap((c) => (c.commands as string[] | undefined) ?? []);
    expect(commands).toContain("selectAll");
    expect(commands).toContain("deleteBackward");
    // selectAll must precede the delete, or there is nothing selected to remove.
    expect(commands.indexOf("selectAll")).toBeLessThan(commands.indexOf("deleteBackward"));
  });

  // The actuator can run on either platform, so both chords go out; the
  // `commands` array makes the redundant one a no-op.
  it("sends both the Meta and Ctrl select-all chords", async () => {
    const mods: unknown[] = [];
    const send = async (_t: number, _m: string, p?: object) => {
      const q = (p ?? {}) as Record<string, unknown>;
      if ((q.commands as string[] | undefined)?.includes("selectAll")) mods.push(q.modifiers);
      return undefined;
    };
    await clearFocusedEditor(send, 7, noSleep);
    expect(mods).toEqual([4, 2]); // 4 = Meta/⌘, 2 = Ctrl
  });

  // A keyDown carrying `text` would insert a character instead of deleting one.
  it("never sends a keyDown with text", async () => {
    const calls: Record<string, unknown>[] = [];
    const send = async (_t: number, _m: string, p?: object) => {
      calls.push((p ?? {}) as Record<string, unknown>);
      return undefined;
    };
    await clearFocusedEditor(send, 7, noSleep);
    expect(calls.every((c) => c.text === undefined)).toBe(true);
    expect(calls.every((c) => c.type !== "keyDown")).toBe(true);
  });
});

function deps(over: Partial<ClearComposerDeps> = {}): ClearComposerDeps {
  return {
    focusBox: async () => true,
    clearKeys: async () => {},
    isEmpty: async () => true,
    sleep: noSleep,
    ...over,
  };
}

describe("runClearComposer", () => {
  it("does nothing when the box is already empty", async () => {
    const focusBox = vi.fn(async () => true);
    const clearKeys = vi.fn(async () => {});
    const ok = await runClearComposer(deps({ focusBox, clearKeys, isEmpty: async () => true }));
    expect(ok).toBe(true);
    expect(focusBox).not.toHaveBeenCalled();
    expect(clearKeys).not.toHaveBeenCalled();
  });

  it("treats a missing composer as nothing to clear", async () => {
    const clearKeys = vi.fn(async () => {});
    const ok = await runClearComposer(deps({ isEmpty: async () => false, focusBox: async () => false, clearKeys }));
    expect(ok).toBe(true);
    expect(clearKeys).not.toHaveBeenCalled();
  });

  // THE case this exists for: text left behind by a failed send, which would
  // make the next chrome.tabs.update raise "Leave site?".
  it("focuses and clears a dirty composer, then confirms it is empty", async () => {
    let empty = false;
    const clearKeys = vi.fn(async () => {
      empty = true;
    });
    const focusBox = vi.fn(async () => true);
    const ok = await runClearComposer(deps({ isEmpty: async () => empty, focusBox, clearKeys }));
    expect(ok).toBe(true);
    expect(focusBox).toHaveBeenCalled();
    expect(clearKeys).toHaveBeenCalledTimes(1);
  });

  // The editors are React-controlled, so the model empties a frame or two after
  // the keystroke. Reading once would report a false failure.
  it("polls for emptiness rather than reading once", async () => {
    let reads = 0;
    const ok = await runClearComposer(
      deps({
        isEmpty: async () => {
          reads += 1;
          return reads > 3; // empty only on the 4th read
        },
      })
    );
    expect(ok).toBe(true);
  });

  it("retries the clear before giving up", async () => {
    const clearKeys = vi.fn(async () => {});
    const ok = await runClearComposer(deps({ isEmpty: async () => false, clearKeys }));
    expect(ok).toBe(false);
    expect(clearKeys).toHaveBeenCalledTimes(2); // default attempts
  });

  // This runs on failure paths that already decided the draft's fate. An
  // exception here must not turn a handled reply failure into a tick error.
  it("never throws when a dependency rejects", async () => {
    await expect(
      runClearComposer(
        deps({
          isEmpty: async () => {
            throw new Error("No tab with given id 7.");
          },
        })
      )
    ).resolves.toBe(false);
  });
});

describe("makeNavigateTab", () => {
  // THE invariant this wrapper exists for. Navigating first and clearing after
  // is exactly the bug: the dialog is raised by the navigation itself, so a
  // clear that runs afterwards is too late and the run is already wedged.
  it("clears the composer BEFORE it navigates", async () => {
    const order: string[] = [];
    const navigate = makeNavigateTab({
      clearComposer: async () => {
        order.push("clear");
      },
      updateTab: async () => {
        order.push("navigate");
      },
    });
    await navigate(7, "https://example.com/post");
    expect(order).toEqual(["clear", "navigate"]);
  });

  it("passes the tab and url straight through to the navigation", async () => {
    const updateTab = vi.fn(async () => {});
    await makeNavigateTab({ clearComposer: async () => {}, updateTab })(7, "https://example.com/post");
    expect(updateTab).toHaveBeenCalledWith(7, "https://example.com/post");
  });

  // doComment/doReply type into the page after navigating and rely on the throw
  // to report a nav failure. Swallowing it here would let them hunt for a
  // composer on whatever page the tab actually shows — a reply under the WRONG
  // post at worst.
  it("propagates a failed navigation", async () => {
    const navigate = makeNavigateTab({
      clearComposer: async () => {},
      updateTab: async () => {
        throw new Error("No tab with given id 7.");
      },
    });
    await expect(navigate(7, "https://example.com/post")).rejects.toThrow("No tab with given id 7.");
  });

  // The clear is best-effort cleanup (runClearComposer already swallows), but a
  // clearComposer that somehow rejects must not block the navigation the caller
  // actually asked for — that would convert a cosmetic stall into a dead run.
  it("still navigates when the clear rejects", async () => {
    const updateTab = vi.fn(async () => {});
    const navigate = makeNavigateTab({
      clearComposer: async () => {
        throw new Error("tab closed");
      },
      updateTab,
    });
    await expect(navigate(7, "https://example.com/post")).resolves.toBeUndefined();
    expect(updateTab).toHaveBeenCalledWith(7, "https://example.com/post");
  });

  describe("shouldProceed", () => {
    it("does not even clear when the caller has already lost interest", async () => {
      const clearComposer = vi.fn(async () => {});
      const updateTab = vi.fn(async () => {});
      await makeNavigateTab({ clearComposer, updateTab, shouldProceed: async () => false })(7, "u");
      expect(clearComposer).not.toHaveBeenCalled();
      expect(updateTab).not.toHaveBeenCalled();
    });

    // THE reason it is checked twice. The clear is several round trips long; a
    // condition that flips inside it (a STOP, an epoch bump) must abandon the
    // hop — and bailing only at updateTab would already have wiped the
    // operator's draft for a navigation that never happens.
    it("abandons the navigation when the condition flips DURING the clear", async () => {
      const updateTab = vi.fn(async () => {});
      let live = true;
      await makeNavigateTab({
        clearComposer: async () => { live = false; },
        updateTab,
        shouldProceed: async () => live,
      })(7, "u");
      expect(updateTab).not.toHaveBeenCalled();
    });

    it("clears and navigates as usual while the condition holds", async () => {
      const order: string[] = [];
      await makeNavigateTab({
        clearComposer: async () => { order.push("clear"); },
        updateTab: async () => { order.push("navigate"); },
        shouldProceed: async () => true,
      })(7, "u");
      expect(order).toEqual(["clear", "navigate"]);
    });
  });
});

// Gate on the DM send confirmation. Its whole job is to keep a DELIVERED
// message from being re-queued and sent a second time to a real person, so the
// only answer that may be "yes, this is still our un-sent draft" is one where
// the text genuinely is ours.
describe("sameDraft (DM send confirmation)", () => {
  const BODY = "Hey Dana, saw your post about migrating the billing service — how did the cutover go?";

  it("matches our own draft still sitting in the box", () => {
    expect(sameDraft(BODY, BODY)).toBe(true);
  });

  it("matches through the editor's whitespace reflow", () => {
    expect(sameDraft(`  Hey   Dana,\n saw your post about migrating\nthe billing service — how did the cutover go?  `, BODY)).toBe(true);
  });

  // THE regression. typeText sends "\n" via Input.insertText and a
  // contenteditable turns it into a block boundary contributing NO character to
  // textContent, so the newline simply VANISHES from the read-back. 98 of the
  // 113 DM drafts in the live DB carry one inside the first 40 chars, so a
  // whitespace-collapsing compare (which normalises the two sides in opposite
  // directions) missed on essentially every real DM — leaving both the miss
  // detection and the unwind's ownership check permanently inert.
  it("matches a body whose newline the contenteditable dropped entirely", () => {
    const multiline = "hellooo jessika\nday 44 of building in public and the demo finally works";
    const asRead = "hellooo jessikaday 44 of building in public and the demo finally works";
    expect(sameDraft(asRead, multiline)).toBe(true);
  });

  it("still tells two different multi-line drafts apart", () => {
    const ours = "hellooo jessika\nday 44 of building in public";
    const theirs = "hey marcus\nquick question about your pricing page";
    expect(sameDraft(theirs.replace("\n", ""), ours)).toBe(false);
  });

  // THE case. findMessageCompose returns the first `.msg-form` editable, and the
  // messaging rail can hold several open bubbles — so a sent DM can still find a
  // non-empty box belonging to a conversation the operator is typing in. Calling
  // that a miss re-sends the DM.
  it("does NOT match a different conversation's draft", () => {
    expect(sameDraft("no worries, talk monday", BODY)).toBe(false);
  });

  it("does not match an empty box, or treat an empty body as a match for anything", () => {
    expect(sameDraft("", BODY)).toBe(false);
    expect(sameDraft("someone else's text", "")).toBe(false);
  });

  // A body too short to make a distinctive prefix must be fully contained
  // rather than matching on a few incidental characters.
  it("requires full containment for a very short body", () => {
    expect(sameDraft("ok then", "ok")).toBe(true);
    expect(sameDraft("nope", "ok")).toBe(false);
  });
});

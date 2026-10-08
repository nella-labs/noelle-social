import { describe, expect, it, vi } from "vitest";
import { locateOrOpenCommentBox } from "../src/background/comment-composer.js";

const box = { ok: true, x: 60, y: 70, rect: { x: 40, y: 50, width: 40, height: 40 } };
const missing = { ok: false, skipReason: "selector-not-found" };
const action = { ok: true, x: 20, y: 30, rect: { x: 10, y: 20, width: 20, height: 20 } };
const noWait = async () => {};

describe("opening a collapsed post comment composer", () => {
  it("uses an already mounted editor without clicking another post action", async () => {
    const locateAction = vi.fn();
    const openAction = vi.fn();
    const result = await locateOrOpenCommentBox({
      locateBox: vi.fn().mockResolvedValue(box), locateAction, openAction, canContinue: vi.fn(), waitForRetry: noWait,
    });
    expect(result).toEqual(box);
    expect(locateAction).not.toHaveBeenCalled();
    expect(openAction).not.toHaveBeenCalled();
  });

  it("opens the post action once and re-locates the mounted editor", async () => {
    const locateBox = vi.fn().mockResolvedValueOnce(missing).mockResolvedValueOnce(box);
    const openAction = vi.fn().mockResolvedValue(undefined);
    const result = await locateOrOpenCommentBox({
      locateBox, locateAction: vi.fn().mockResolvedValue(action), openAction,
      canContinue: vi.fn().mockResolvedValue(true), waitForRetry: noWait,
    });
    expect(result).toEqual(box);
    expect(locateBox).toHaveBeenCalledTimes(2);
    expect(openAction).toHaveBeenCalledExactlyOnceWith(action);
  });

  it("waits a bounded number of times for a late-mounted editor", async () => {
    const locateBox = vi.fn()
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce({ ok: false, skipReason: "box-zero-rect" })
      .mockResolvedValueOnce(box);
    const waitForRetry = vi.fn().mockResolvedValue(undefined);
    const openAction = vi.fn().mockResolvedValue(undefined);
    expect(await locateOrOpenCommentBox({
      locateBox, locateAction: vi.fn().mockResolvedValue(action), openAction,
      canContinue: vi.fn().mockResolvedValue(true), waitForRetry,
    })).toEqual(box);
    expect(openAction).toHaveBeenCalledTimes(1);
    expect(locateBox).toHaveBeenCalledTimes(4);
    expect(waitForRetry).toHaveBeenCalledTimes(2);
  });

  it("opens a hidden editor, but never clicks when the challenge guard blocks", async () => {
    const locateAction = vi.fn().mockResolvedValue(action);
    const openAction = vi.fn();
    const hidden = { ok: false, skipReason: "box-zero-rect" };
    expect(await locateOrOpenCommentBox({
      locateBox: vi.fn().mockResolvedValueOnce(hidden).mockResolvedValueOnce(box),
      locateAction, openAction, canContinue: vi.fn().mockResolvedValue(true), waitForRetry: noWait,
    })).toEqual(box);
    expect(openAction).toHaveBeenCalledTimes(1);
    locateAction.mockClear();
    openAction.mockClear();
    expect(await locateOrOpenCommentBox({
      locateBox: vi.fn().mockResolvedValue(missing), locateAction, openAction,
      canContinue: vi.fn().mockResolvedValue(false), waitForRetry: noWait,
    })).toMatchObject({ ok: false, skipReason: "challenge" });
    expect(locateAction).not.toHaveBeenCalled();
    expect(openAction).not.toHaveBeenCalled();
  });

  it("keeps the precise action failure and propagates STOP", async () => {
    const absent = { ok: false, skipReason: "comment-action-not-found" };
    expect(await locateOrOpenCommentBox({
      locateBox: vi.fn().mockResolvedValue(missing), locateAction: vi.fn().mockResolvedValue(absent),
      openAction: vi.fn(), canContinue: vi.fn().mockResolvedValue(true), waitForRetry: noWait,
    })).toEqual(absent);
    await expect(locateOrOpenCommentBox({
      locateBox: vi.fn().mockResolvedValue(missing), locateAction: vi.fn(), openAction: vi.fn(),
      canContinue: vi.fn().mockRejectedValue(new Error("stopped")), waitForRetry: noWait,
    })).rejects.toThrow("stopped");
  });
});

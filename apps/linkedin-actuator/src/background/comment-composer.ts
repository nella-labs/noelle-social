import type { LocateResult } from "../content/locators.js";

/** Open the post action only when the permalink has not mounted its editor. */
export async function locateOrOpenCommentBox(args: {
  locateBox: () => Promise<LocateResult>;
  locateAction: () => Promise<LocateResult>;
  openAction: (action: LocateResult) => Promise<void>;
  waitForRetry: () => Promise<void>;
  /** Throws on STOP and returns false on a challenge. */
  canContinue: () => Promise<boolean>;
}): Promise<LocateResult> {
  const box = await args.locateBox();
  if (box.ok || !["selector-not-found", "box-zero-rect"].includes(box.skipReason ?? "")) return box;
  if (!(await args.canContinue())) return { ok: false, skipReason: "challenge" };
  const action = await args.locateAction();
  if (!action.ok || action.x == null) {
    return { ok: false, skipReason: action.skipReason ?? "comment-action-not-found" };
  }
  if (!(await args.canContinue())) return { ok: false, skipReason: "challenge" };
  await args.openAction(action);
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!(await args.canContinue())) return { ok: false, skipReason: "challenge" };
    const mounted = await args.locateBox();
    if (mounted.ok || !["selector-not-found", "box-zero-rect"].includes(mounted.skipReason ?? "")) return mounted;
    if (attempt === 3) return mounted;
    await args.waitForRetry();
  }
  return { ok: false, skipReason: "selector-not-found" };
}

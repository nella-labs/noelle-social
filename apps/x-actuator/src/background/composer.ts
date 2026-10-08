import type { Rect } from "./engage.js";

export type ComposerLocation = { ok: boolean; x?: number; y?: number; rect?: Rect; skipReason?: string };

export type ComposerDeps = {
  now(): number;
  sleep(ms: number): Promise<void>;
  stale(): Promise<boolean>;
  onTarget(): Promise<boolean>;
  postUnavailable(): Promise<boolean>;
  replyRestricted(): Promise<boolean>;
  locateBox(): Promise<ComposerLocation | null>;
};

export type ComposerOutcome =
  | { kind: "ready"; box: ComposerLocation }
  | { kind: "unavailable"; detail: "post-unavailable" | "reply-restricted" }
  | { kind: "missing"; detail: string }
  | { kind: "stopped" };

function missingDetail(selectorReason: string | undefined, tweetId: string | null): string {
  const selector = (selectorReason ?? "selector-not-found").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "unknown";
  const target = tweetId && /^\d{1,24}$/.test(tweetId) ? `,tweet=${tweetId}` : "";
  return `box-not-found(selector=${selector}${target})`;
}

const targetChangedDetail = (tweetId: string | null) =>
  tweetId && /^\d{1,24}$/.test(tweetId) ? `target-url-changed(tweet=${tweetId})` : "target-url-changed";

/** Wait on the target permalink's actual composer, not on a fixed hydration delay. */
export async function waitForReplyComposer(d: ComposerDeps, tweetId: string | null, timeoutMs = 6000): Promise<ComposerOutcome> {
  const deadline = d.now() + Math.max(0, timeoutMs);
  let lastReason: string | undefined;
  while (true) {
    if (await d.stale()) return { kind: "stopped" };
    if (!(await d.onTarget())) return { kind: "missing", detail: targetChangedDetail(tweetId) };

    // Either terminal state can mount after tab.status has become "complete".
    // Recheck on each attempt, before accepting a composer or timing out.
    if (await d.postUnavailable()) {
      if (!(await d.onTarget())) return { kind: "missing", detail: targetChangedDetail(tweetId) };
      return { kind: "unavailable", detail: "post-unavailable" };
    }
    if (await d.replyRestricted()) {
      if (!(await d.onTarget())) return { kind: "missing", detail: targetChangedDetail(tweetId) };
      return { kind: "unavailable", detail: "reply-restricted" };
    }

    if (!(await d.onTarget())) return { kind: "missing", detail: targetChangedDetail(tweetId) };
    const box = await d.locateBox().catch(() => null);
    if (box?.ok && box.x != null) {
      if (await d.stale()) return { kind: "stopped" };
      if (!(await d.onTarget())) return { kind: "missing", detail: targetChangedDetail(tweetId) };
      return { kind: "ready", box };
    }
    lastReason = box?.skipReason ?? "content-script-unreachable";
    const remaining = deadline - d.now();
    if (remaining <= 0) return { kind: "missing", detail: missingDetail(lastReason, tweetId) };
    await d.sleep(Math.min(400, remaining));
  }
}

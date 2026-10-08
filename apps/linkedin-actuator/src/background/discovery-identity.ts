import type { CapturedCopyLink } from "./clipboard-capture.js";
import { directShortPostUrl } from "../lib/urn.js";

export type PendingDiscoveryIdentity = { leadId: string; fingerprint: string };
export const DISCOVERY_IDENTITY_STATUS_KEY = "actuator.discoveryIdentityStatus";
export type CopyFailure = {
  stage: "guard" | "locate" | "stopped" | "install" | "click" | "read" | "invalid-url" | "restore" | "exception";
  locatorReason?: string;
  menuDiagnostic?: string;
  writes?: "none" | "one" | "many";
  method?: "none" | "writeText" | "write" | "copy" | "execCommand" | "mixed";
};
export type DiscoveryIdentityOutcome = {
  result: "resolved" | "not-visible" | "unresolved";
  reason?: string;
  diagnostic?: string;
  copy?: CopyFailure;
};

const copyStages = new Set<CopyFailure["stage"]>([
  "guard", "locate", "stopped", "install", "click", "read", "invalid-url", "restore", "exception",
]);
const copyLocatorReasons = new Set([
  "post-menu-not-selected", "ambiguous-open-menu", "not-post-menu", "post-menu-not-open",
  "copy-link-not-found", "ambiguous-copy-link", "copy-link-zero-rect",
]);
const menuShapePattern = /^expanded=(?:true|false|none);totalMenus=\d{1,2};menus=\d{1,2};opened=\d{1,2};updated=\d{1,2};save=\d{1,2};copy=\d{1,2};menuitems=\d{1,2};pageSave=\d{1,2};pageCopy=\d{1,2};pageMenuitems=\d{1,2};outlet=(?:open|closed|absent);outletControls=\d{1,2}$/;

function safeCopyFailure(raw: CopyFailure | undefined): CopyFailure {
  if (!raw || typeof raw !== "object") return { stage: "exception" };
  return {
    stage: copyStages.has(raw.stage) ? raw.stage : "exception",
    ...(raw.locatorReason && copyLocatorReasons.has(raw.locatorReason) ? { locatorReason: raw.locatorReason } : {}),
    ...(raw.menuDiagnostic && menuShapePattern.test(raw.menuDiagnostic) ? { menuDiagnostic: raw.menuDiagnostic } : {}),
    ...(raw.writes === "none" || raw.writes === "one" || raw.writes === "many" ? { writes: raw.writes } : {}),
    ...(["none", "writeText", "write", "copy", "execCommand", "mixed"].includes(raw.method ?? "") ? { method: raw.method } : {}),
  };
}

type Rect = { x: number; y: number; width: number; height: number };
type CopyLocatorResult = {
  ok: boolean;
  rect?: Rect;
  skipReason?: string;
  diagnostic?: string;
};
const unsafeCopyMenuReasons = new Set([
  "ambiguous-open-menu", "ambiguous-copy-link", "post-menu-not-selected",
]);
export const unsafeCopyMenuReason = (reason: string | undefined): boolean =>
  reason !== undefined && unsafeCopyMenuReasons.has(reason);

/** Add at most 2.45 s of DOM reads after the resolver's existing menu waits. */
export async function locateCopyLinkAfterHydration(args: {
  isCurrent(): Promise<boolean>;
  locate(): Promise<CopyLocatorResult>;
  wait(): Promise<void>;
}): Promise<CopyLocatorResult> {
  let last: CopyLocatorResult = { ok: false, skipReason: "copy-link-not-found" };
  for (let read = 0; read < 8; read++) {
    if (read > 0) {
      try { await args.wait(); }
      catch { return { ok: false, skipReason: "stopped" }; }
    }
    if (!(await args.isCurrent().catch(() => false))) return { ok: false, skipReason: "stopped" };
    last = await args.locate().catch(() => ({ ok: false, skipReason: "copy-link-not-found" }));
    if (unsafeCopyMenuReason(last.skipReason)) return last;
    if (last.ok && last.rect) return last;
  }
  return last;
}

/** Resolve up to five Jev-qualified visible cards during one existing ambient read slot. */
export async function resolveVisibleDiscoveryIdentity(args: {
  stopped(): boolean;
  enabled(): Promise<boolean>;
  visibleFingerprints: string[];
  pending(fingerprints: string[]): Promise<{ items: PendingDiscoveryIdentity[]; processing: number }>;
  /** Cards already tried during this paced read must not be clicked again while Jev settles the rest. */
  attempted?: Set<string>;
  locate(fingerprint: string): Promise<{ ok: boolean; rect?: Rect; skipReason?: string }>;
  click(rect: Rect): Promise<void>;
  wait(): Promise<void>;
  readShareUrn(): Promise<{ ok: boolean; urn?: string; skipReason?: string; diagnostic?: string }>;
  /** One bounded Copy link action, only after the opened menu has no URL. */
  captureCopyLink?(): Promise<CapturedCopyLink | { failure: CopyFailure } | undefined>;
  closeMenu(): Promise<void>;
  resolve(item: PendingDiscoveryIdentity, urn: string): Promise<{ resolved: boolean; duplicate: boolean }>;
  resolveShortLink?(item: PendingDiscoveryIdentity, shortUrl: string): Promise<{ resolved: boolean; duplicate: boolean }>;
  report?(outcome: DiscoveryIdentityOutcome): Promise<void>;
}): Promise<"stopped" | "none" | "classifying" | "not-visible" | "unresolved" | "resolved"> {
  if (args.stopped() || !(await args.enabled())) return "stopped";
  if (args.visibleFingerprints.length === 0) return "none";
  const pending = await args.pending(args.visibleFingerprints);
  const candidates = pending.items.filter((item) => !args.attempted?.has(item.leadId)).slice(0, 5);
  if (candidates.length === 0) return pending.processing > 0 ? "classifying" : "none";
  let missingReason = "qualified-post-not-visible";
  let resolved = false;
  let unresolved = false;
  for (const item of candidates) {
    if (args.stopped() || !(await args.enabled())) return "stopped";
    args.attempted?.add(item.leadId);
    let target = await args.locate(item.fingerprint);
    // scrollIntoView can return before the menu has a nonzero layout box.
    if (!target.ok && target.skipReason === "post-menu-zero-rect") {
      await args.wait();
      if (args.stopped() || !(await args.enabled())) return "stopped";
      target = await args.locate(item.fingerprint);
    }
    if (!target.ok || !target.rect) {
      missingReason = target.skipReason ?? missingReason;
      continue;
    }
    await args.click(target.rect);
    let urn: string | undefined;
    let shortUrl: string | undefined;
    let copyFailure: CopyFailure | undefined;
    try {
      let reason = "embed-link-not-found";
      let diagnostic: string | undefined;
      let missingLinkOnly = true;
      // LinkedIn's menu hydrates asynchronously. These are bounded DOM reads
      // of the same open menu; no extra navigation or second menu click.
      for (let attempt = 0; attempt < 3; attempt++) {
        await args.wait();
        if (args.stopped() || !(await args.enabled())) return "stopped";
        const observed = await args.readShareUrn();
        if (observed.ok && /^urn:li:(?:share|activity):\d{10,}$/.test(observed.urn ?? "")) {
          urn = observed.urn;
          break;
        }
        const observedReason = observed.skipReason ?? "invalid-share-urn";
        if (observedReason !== "embed-link-not-found") missingLinkOnly = false;
        if (missingLinkOnly || observedReason !== "embed-link-not-found") reason = observedReason;
        diagnostic = observed.diagnostic?.slice(0, 600) ?? diagnostic;
      }
      if (!urn && missingLinkOnly && args.captureCopyLink) {
        if (args.stopped() || !(await args.enabled())) return "stopped";
        try {
          const captured = await args.captureCopyLink();
          if (captured && "urn" in captured && /^urn:li:activity:\d{10,}$/.test(captured.urn)) urn = captured.urn;
          else if (captured && "shortUrl" in captured && args.resolveShortLink) {
            shortUrl = directShortPostUrl(captured.shortUrl);
            if (!shortUrl) { reason = "copy-link-not-resolved"; copyFailure = { stage: "invalid-url" }; }
          } else {
            reason = "copy-link-not-resolved";
            copyFailure = captured && "failure" in captured
              ? safeCopyFailure(captured.failure) : { stage: "exception" };
          }
        } catch { reason = "copy-link-capture-failed"; copyFailure = { stage: "exception" }; }
      }
      if (!urn && !shortUrl) {
        await args.report?.({ result: "unresolved", reason, ...(diagnostic ? { diagnostic } : {}),
          ...(copyFailure ? { copy: copyFailure } : {}) });
        unresolved = true;
      }
    } finally {
      await args.closeMenu();
    }
    if (!urn && !shortUrl) continue;
    if (args.stopped() || !(await args.enabled())) return "stopped";
    let result: { resolved: boolean; duplicate: boolean };
    try {
      result = shortUrl ? await args.resolveShortLink!(item, shortUrl) : await args.resolve(item, urn!);
    } catch {
      await args.report?.({ result: "unresolved", reason: "identity-resolve-failed" });
      unresolved = true;
      continue;
    }
    const outcome = result.resolved || result.duplicate ? "resolved" : "unresolved";
    await args.report?.({ result: outcome, ...(outcome === "unresolved" ? { reason: "identity-not-resolved" } : {}) });
    if (outcome === "resolved") resolved = true;
    else unresolved = true;
  }
  if (pending.processing > 0) return "classifying";
  if (resolved) return "resolved";
  if (unresolved) return "unresolved";
  await args.report?.({ result: "not-visible", reason: missingReason });
  return "not-visible";
}

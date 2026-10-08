// executeOp — the extension's whole capability surface. The bridge queues a
// ChromeOp; the SW polls it, runs it here, and reports the ChromeOpResult.
//
// SAFETY INVARIANT (the reason this extension can share a browser with a live
// actuator run): the DEFAULT control path — tabs.*, dom.*, page.screenshot,
// page.console — uses chrome.tabs + chrome.scripting ONLY. It never calls
// chrome.debugger, so it can never take the single per-tab debugger slot that an
// actuator's CDP run owns. Only the opt-in debugger.* ops touch chrome.debugger,
// and debugger.attach refuses an actuator domain / an already-attached tab unless
// force:true (see the guard below).
import type { ChromeOp, ChromeOpResult, TabInfo, ExtEvent } from "@noelle/contracts";
import { event as postEvent } from "./net.js";

const DEBUGGER_PROTOCOL_VERSION = "1.3";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Pure helpers (no chrome.* — unit-tested in ops.test.ts).
// ---------------------------------------------------------------------------

// Domains an actuator drives with chrome.debugger. debugger.attach refuses these
// without force so the bridge can never steal the slot from a live Vega/Lyra/Orion
// run. Apex + any subdomain (mobile.twitter.com, pro.x.com, …) all count.
export const ACTUATOR_HOSTS = [
  "x.com",
  "twitter.com",
  "linkedin.com",
  "www.linkedin.com",
  "reddit.com",
  "www.reddit.com",
] as const;

/** Hostname of a URL, lowercased, or null if it doesn't parse. A trailing dot
 * (the fully-qualified form, e.g. `x.com.` which Chrome loads as x.com) is
 * stripped so it can't slip past the actuator-domain guard. */
export function hostOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** True when `url`'s host is (a subdomain of) an actuator domain. */
export function isActuatorDomain(url: string | undefined | null): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return ACTUATOR_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

// Minimal shape of a chrome.tabs.Tab that buildTabInfo needs. chrome.tabs.Tab is
// structurally assignable to this, and a plain object works in tests.
export interface TabLike {
  id?: number;
  windowId?: number;
  index?: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  active?: boolean;
  status?: string;
  discarded?: boolean;
  audible?: boolean;
}

/** Map a chrome tab onto the wire TabInfo. `attachedTabIds`, when given, sets
 * debuggerAttached by membership (from chrome.debugger.getTargets — which does NOT
 * consume the slot). */
export function buildTabInfo(tab: TabLike, attachedTabIds?: Set<number>): TabInfo {
  const info: TabInfo = {
    id: tab.id ?? -1,
    windowId: tab.windowId ?? -1,
    url: tab.url ?? tab.pendingUrl ?? "",
    title: tab.title ?? "",
    active: tab.active ?? false,
  };
  if (tab.index !== undefined) info.index = tab.index;
  if (tab.status !== undefined) info.status = tab.status;
  if (tab.discarded !== undefined) info.discarded = tab.discarded;
  if (tab.audible !== undefined) info.audible = tab.audible;
  if (attachedTabIds) info.debuggerAttached = tab.id != null && attachedTabIds.has(tab.id);
  return info;
}

/** Match a URL against an optional filter: substring match, or glob when the
 * pattern contains `*` (anchored, `*` → `.*`). */
export function urlMatches(url: string, pattern: string): boolean {
  if (!pattern.includes("*")) return url.includes(pattern);
  const re = new RegExp("^" + pattern.split("*").map(escapeRegExp).join(".*") + "$");
  return re.test(url);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Chrome major.minor.build.patch from the UA string, when present. */
export function chromeVersion(): string | undefined {
  try {
    return /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1];
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Page-injected functions (chrome.scripting.executeScript). Each MUST be a
// self-contained function: executeScript serializes func.toString() and runs it
// in the page, so these close over NOTHING from this module — only their args and
// page globals (document, HTMLElement, Event, eval, …).
// ---------------------------------------------------------------------------

// dom.eval: MV3 forbids string eval INSIDE the extension, but indirect eval in the
// page's MAIN world is permitted (subject to the page's own CSP — strict-CSP sites
// like x.com/linkedin.com may still block it, which surfaces as a __bridgeError).
// Returns the promise itself when awaitPromise so executeScript resolves it
// (Chrome ≥111 awaits a Promise returned by an injected func).
function evalInPage(code: string, awaitPromise: boolean): unknown {
  try {
    const out = (0, eval)(code);
    if (out && typeof (out as { then?: unknown }).then === "function") {
      if (!awaitPromise) return { __unawaitedPromise: true };
      return (out as Promise<unknown>).then(
        (v) => v,
        (e) => ({ __bridgeError: e instanceof Error ? e.stack || e.message : String(e) }),
      );
    }
    return out;
  } catch (e) {
    return { __bridgeError: e instanceof Error ? e.stack || e.message : String(e) };
  }
}

function clickInPage(selector: string): { ok: boolean; error?: string } {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return { ok: false, error: `no element matches ${selector}` };
  el.click();
  return { ok: true };
}

function typeInPage(
  selector: string,
  text: string,
  dispatchEvents: boolean,
): { ok: boolean; error?: string } {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return { ok: false, error: `no element matches ${selector}` };
  el.focus?.();
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") {
    const input = el as HTMLInputElement | HTMLTextAreaElement;
    // React tracks the value via its own setter; write through the NATIVE setter to
    // bypass the tracker, then fire input/change so React (and plain listeners) see
    // the update. Setting input.value directly is silently ignored by React.
    const proto = tag === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(input, text);
    else input.value = text;
    if (dispatchEvents) {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { ok: true };
  }
  if ((el as HTMLElement & { isContentEditable?: boolean }).isContentEditable) {
    el.textContent = text;
    if (dispatchEvents) el.dispatchEvent(new Event("input", { bubbles: true }));
    return { ok: true };
  }
  return { ok: false, error: "element is not an input, textarea, or contenteditable" };
}

function queryInPage(
  selector: string,
  limit: number,
): Array<{ outerHTML: string; textContent: string; attrs: Record<string, string> }> {
  const els = Array.from(document.querySelectorAll(selector)).slice(0, limit);
  return els.map((el) => {
    const attrs: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
    return {
      outerHTML: (el as HTMLElement).outerHTML.slice(0, 4000),
      textContent: (el.textContent ?? "").slice(0, 2000),
      attrs,
    };
  });
}

// ---------------------------------------------------------------------------
// chrome.debugger state + the attach guard.
// ---------------------------------------------------------------------------

// Tabs THIS extension has a debugger session on. Lets debugger.attach be
// idempotent for our own attaches, and debugger.detach clean up. onDetach (a tab
// close, or another client detaching) prunes it.
const ownAttached = new Set<number>();

if (typeof chrome !== "undefined" && chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {

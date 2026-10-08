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
    if (source.tabId != null) ownAttached.delete(source.tabId);
  });
}

/** Tab ids that currently have ANY chrome.debugger client attached (ours OR an
 * actuator's). getTargets does NOT consume the slot, so calling it is safe from
 * the default control path. */
async function getAttachedTabIds(): Promise<Set<number>> {
  const ids = new Set<number>();
  try {
    const targets = await chrome.debugger.getTargets();
    for (const t of targets) if (t.attached && typeof t.tabId === "number") ids.add(t.tabId);
  } catch {
    // ignore — worst case debuggerAttached is under-reported.
  }
  return ids;
}

async function emitEvent(kind: ExtEvent["kind"], data: Record<string, unknown>): Promise<void> {
  try {
    await postEvent({ kind, at: new Date().toISOString(), data });
  } catch {
    // fail-open — an event is telemetry, never load-bearing.
  }
}

// ---------------------------------------------------------------------------
// executeOp
// ---------------------------------------------------------------------------

/** Run one ChromeOp and wrap it in a ChromeOpResult (ok/value/error + tookMs).
 * Any throw from runOp — including a deliberate guard refusal or a "not found" —
 * becomes { ok:false, error }. */
export async function executeOp(op: ChromeOp): Promise<ChromeOpResult> {
  const started = Date.now();
  try {
    const value = await runOp(op);
    return { ok: true, value, tookMs: Date.now() - started };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), tookMs: Date.now() - started };
  }
}

async function runOp(op: ChromeOp): Promise<unknown> {
  switch (op.op) {
    // --- tabs (chrome.tabs; no debugger slot) ---
    case "tabs.list": {
      const tabs = await chrome.tabs.query({});
      const attached = await getAttachedTabIds();
      let infos = tabs.map((t) => buildTabInfo(t, attached));
      if (op.urlPattern) {
        const pattern = op.urlPattern;
        infos = infos.filter((i) => urlMatches(i.url, pattern));
      }
      return infos;
    }
    case "tabs.create": {
      const tab = await chrome.tabs.create({ url: op.url, active: op.active, windowId: op.windowId });
      return buildTabInfo(tab);
    }
    case "tabs.navigate": {
      const tab = await chrome.tabs.update(op.tabId, { url: op.url });
      return buildTabInfo(tab ?? { id: op.tabId });
    }
    case "tabs.activate": {
      const tab = await chrome.tabs.update(op.tabId, { active: true });
      if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      return buildTabInfo(tab ?? { id: op.tabId });
    }
    case "tabs.close": {
      await chrome.tabs.remove(op.tabId);
      return { closed: op.tabId };
    }
    case "tabs.reload": {
      await chrome.tabs.reload(op.tabId, { bypassCache: op.bypassCache });
      return { reloaded: op.tabId };
    }
    case "tabs.waitForLoad": {
      const deadline = Date.now() + op.timeoutMs;
      while (Date.now() < deadline) {
        const tab = await chrome.tabs.get(op.tabId).catch(() => null);
        if (!tab) throw new Error(`tab ${op.tabId} not found`);
        if (tab.status === "complete") return buildTabInfo(tab);
        await sleep(250);
      }
      throw new Error(`tab ${op.tabId} did not reach status:complete within ${op.timeoutMs}ms`);
    }

    // --- DOM/JS (chrome.scripting.executeScript; no debugger slot) ---
    case "dom.eval": {
      // MAIN world so the expression sees the page's own globals (window.__stuff,
      // React devtools hooks, etc.). ISOLATED can't reach them.
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId: op.tabId },
        world: op.world,
        args: [op.expression, op.awaitPromise],
        func: evalInPage,
      });
      const r = inj?.result as unknown;
      if (r && typeof r === "object" && "__bridgeError" in r) {
        throw new Error(String((r as { __bridgeError: unknown }).__bridgeError));
      }
      return r;
    }
    case "dom.click": {
      // ISOLATED world (the default): querySelector + .click() only touch the shared
      // DOM, so no page CSP / eval concern — works even on strict-CSP actuator pages.
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId: op.tabId },
        args: [op.selector],
        func: clickInPage,
      });
      const r = inj?.result as { ok: boolean; error?: string } | undefined;
      if (!r?.ok) throw new Error(r?.error ?? "click failed");
      return { clicked: op.selector };
    }
    case "dom.type": {
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId: op.tabId },
        args: [op.selector, op.text, op.dispatchEvents],
        func: typeInPage,
      });
      const r = inj?.result as { ok: boolean; error?: string } | undefined;
      if (!r?.ok) throw new Error(r?.error ?? "type failed");
      return { typed: op.selector, length: op.text.length };
    }
    case "dom.query": {
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId: op.tabId },
        args: [op.selector, op.limit],
        func: queryInPage,
      });
      return inj?.result ?? [];
    }

    // --- capture ---
    case "page.screenshot": {
      const options: chrome.tabs.CaptureVisibleTabOptions = { format: op.format };
      if (op.format === "jpeg" && op.quality != null) options.quality = op.quality;
      if (op.tabId != null) {
        const tab = await chrome.tabs.get(op.tabId);
        // captureVisibleTab grabs the ACTIVE tab of a window; briefly activate the
        // target so we capture the right one (no debugger slot involved).
        if (!tab.active) await chrome.tabs.update(op.tabId, { active: true });
        return await chrome.tabs.captureVisibleTab(tab.windowId, options);
      }
      return await chrome.tabs.captureVisibleTab(options);
    }
    case "page.console": {
      // The console ring buffer lives in the tab's content script (isolated world),
      // fed by the page-console MAIN-world forwarder. Ask it for the buffered lines.
      const lines = await chrome.tabs
        .sendMessage(op.tabId, { cmd: "get-console", sinceMs: op.sinceMs, limit: op.limit })
        .catch(() => null);
      return lines ?? []; // no content script on this tab (chrome:// etc.) → empty
    }

    // --- extension management (chrome.management) ---
    case "ext.list": {
      const all = await chrome.management.getAll();
      return all.map((e) => ({
        id: e.id,
        name: e.name,
        enabled: e.enabled,
        version: e.version,
        installType: e.installType,
        mayDisable: e.mayDisable,
      }));
    }
    case "ext.reload": {
      // Self-reload uses chrome.runtime.reload (chrome.management can't toggle the
      // currently-running extension). For any OTHER dev extension, toggling enabled
      // off→on makes Chrome re-read the unpacked dir — the programmatic equivalent of
      // the Reload button on chrome://extensions.
      if (op.extId === chrome.runtime.id) {
        // Defer so this op's result reports before the SW is torn down.
        setTimeout(() => chrome.runtime.reload(), 250);
        return { reloaded: op.extId, self: true };
      }
      await chrome.management.setEnabled(op.extId, false);
      await chrome.management.setEnabled(op.extId, true);
      return { reloaded: op.extId, self: false };
    }
    case "ext.setEnabled": {
      await chrome.management.setEnabled(op.extId, op.enabled);
      return { extId: op.extId, enabled: op.enabled };
    }

    // --- guarded chrome.debugger passthrough (consumes the per-tab slot) ---
    case "debugger.attach": {
      // Idempotent for a tab we already own — never re-attach (that throws).
      if (ownAttached.has(op.tabId)) return { attached: op.tabId, alreadyOwned: true };

      const tab = await chrome.tabs.get(op.tabId).catch(() => null);
      // Check BOTH the committed url AND pendingUrl: mid-navigation chrome.tabs.get
      // returns the OLD/empty url while pendingUrl holds the actuator domain being
      // loaded, so reading url alone would let an attach during an in-flight nav to
      // x.com/linkedin.com slip past the guard.
      const url = tab?.url || tab?.pendingUrl;
      const host = hostOf(url);
      const onActuator = isActuatorDomain(tab?.url) || isActuatorDomain(tab?.pendingUrl);
      const alreadyAttached = (await getAttachedTabIds()).has(op.tabId);

      // THE GUARD. Refuse to take the single per-tab debugger slot on an actuator
      // domain, or a tab that already has a debugger client, unless force:true. This
      // is what stops the bridge from derailing a live Vega/Lyra/Orion run.
      if (!op.force && onActuator) {
        throw new Error(
          `refusing debugger.attach on actuator domain ${host} (a live actuator run owns the per-tab debugger slot); pass force:true to override`,
        );
      }
      if (!op.force && alreadyAttached) {
        throw new Error(
          `refusing debugger.attach: tab ${op.tabId} already has a debugger attached; pass force:true to override`,
        );
      }
      // force used on an actuator domain: log LOUDLY (console.warn + ExtEvent) — this
      // can steal the slot from, and derail, a live actuator run.
      if (op.force && onActuator) {
        console.warn(
          `[chrome-bridge] FORCE debugger.attach on actuator domain ${host} (tab ${op.tabId}) — this can steal the debugger slot from a live actuator run`,
        );
        await emitEvent("debugger", {
          warning: "force-attach-actuator-domain",
          tabId: op.tabId,
          host: host ?? "",
          url: url ?? "",
        });
      }
      await chrome.debugger.attach({ tabId: op.tabId }, DEBUGGER_PROTOCOL_VERSION);
      ownAttached.add(op.tabId);
      return { attached: op.tabId, host };
    }
    case "debugger.command": {
      // Requires an attached tab (debugger.attach first). sendCommand throws
      // "Debugger is not attached to the tab" otherwise → surfaced as the op error.
      const result = await chrome.debugger.sendCommand({ tabId: op.tabId }, op.method, op.params);
      return result ?? null;
    }
    case "debugger.detach": {
      await chrome.debugger.detach({ tabId: op.tabId }).catch(() => {});
      ownAttached.delete(op.tabId);
      return { detached: op.tabId };
    }

    // --- meta ---
    case "meta.ping":
      return "pong";
    case "meta.info": {
      const manifest = chrome.runtime.getManifest();
      const targets = await chrome.debugger.getTargets().catch(() => [] as chrome.debugger.TargetInfo[]);
      return {
        chromeVersion: chromeVersion(),
        extVersion: manifest.version,
        extId: chrome.runtime.id,
        buildStamp: typeof __BUILD_STAMP__ === "string" ? __BUILD_STAMP__ : null,
        attachedTargets: targets
          .filter((t) => t.attached)
          .map((t) => ({ tabId: t.tabId, url: t.url, title: t.title, type: t.type })),
        ownAttached: [...ownAttached],
      };
    }
  }
}

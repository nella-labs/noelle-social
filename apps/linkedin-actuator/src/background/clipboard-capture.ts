import { directActivityUrn, directShortPostUrl } from "../lib/urn.js";

type CdpValue = { result?: { value?: unknown }; exceptionDetails?: unknown };
export type CapturedCopyLink = { urn: string } | { shortUrl: string };
export type CopyCaptureFailure = {
  stage: "stopped" | "install" | "click" | "read" | "invalid-url" | "restore";
  writes?: "none" | "one" | "many";
  method?: "none" | "writeText" | "write" | "copy" | "execCommand" | "mixed";
};

// The caller's paced wait is 350 ms. Seven reads allow a delayed LinkedIn
// clipboard action about 2.5 s to finish without another click or navigation.
const MAX_READS = 7;

/** Capture only the URL produced by one already-selected post menu action. */
export async function captureCopyLinkIdentity(args: {
  evaluate(expression: string): Promise<unknown>;
  click(): Promise<unknown>;
  wait(): Promise<void>;
  stopped(): boolean;
  /** Fixed stages and write-count buckets only; never receives clipboard content. */
  onFailure?(failure: CopyCaptureFailure): void;
}): Promise<CapturedCopyLink | undefined> {
  if (args.stopped()) { args.onFailure?.({ stage: "stopped" }); return undefined; }
  const key = `__noelle_copy_${crypto.randomUUID()}`;
  const name = JSON.stringify(key);
  const value = (reply: unknown): unknown => {
    const result = reply as CdpValue | null;
    return result && !result.exceptionDetails ? result.result?.value : undefined;
  };
  const install = String.raw`(() => {
    const key = ${name};
    const clip = navigator.clipboard;
    if (Object.prototype.hasOwnProperty.call(window, key)) return false;
    const hooks = [];
    const state = { count: 0, url: '', method: 'none', pending: 0, restore: null, timer: null };
    const record = (method, text) => {
      state.count++;
      state.method = state.method === 'none' || state.method === method ? method : 'mixed';
      if (state.count !== 1) { state.url = ''; return; }
      if (typeof text === 'string' && text.length <= 2048 &&
          (/^https:\/\/(?:www\.)?linkedin\.com\/(?:feed\/update\/|posts\/)/i.test(text) ||
           /^https:\/\/lnkd\.in\/p\//.test(text))) state.url = text;
    };
    const onCopy = (event) => {
      let text = '';
      try { text = event.clipboardData?.getData('text/plain') || ''; } catch {}
      if (text) record('copy', text);
    };
    const restore = () => {
      if (state.timer) clearTimeout(state.timer);
      let restored = true;
      try {
        try { document.removeEventListener('copy', onCopy); } catch { restored = false; }
        for (const entry of hooks.reverse()) {
          try {
            if (entry.descriptor) Object.defineProperty(entry.target, entry.method, entry.descriptor);
            else delete entry.target[entry.method];
          } catch { restored = false; }
        }
      } finally { state.url = ''; delete window[key]; }
      return restored;
    };
    state.restore = restore;
    try {
      if (clip && typeof clip.writeText === 'function') {
        const original = clip.writeText;
        hooks.push({ target: clip, method: 'writeText', descriptor: Object.getOwnPropertyDescriptor(clip, 'writeText') });
        Object.defineProperty(clip, 'writeText', { configurable: true, writable: true, value: function(text) {
          record('writeText', text);
          return Reflect.apply(original, this, arguments);
        } });
      }
      if (clip && typeof clip.write === 'function') {
        const original = clip.write;
        hooks.push({ target: clip, method: 'write', descriptor: Object.getOwnPropertyDescriptor(clip, 'write') });
        Object.defineProperty(clip, 'write', { configurable: true, writable: true, value: function(items) {
          // Invoke the original synchronously with untouched arguments. Read only
          // the text/plain data supplied to this call, never the system clipboard.
          const result = Reflect.apply(original, this, arguments);
          record('write', '');
          if (Array.isArray(items) && items.length === 1 &&
              items[0]?.types?.includes('text/plain') && typeof items[0]?.getType === 'function') {
            state.pending++;
            Promise.resolve().then(() => items[0].getType('text/plain'))
              .then((blob) => blob?.text()).then((text) => {
                if (state.count === 1 && typeof text === 'string') {
                  if (text.length <= 2048 &&
                      (/^https:\/\/(?:www\.)?linkedin\.com\/(?:feed\/update\/|posts\/)/i.test(text) ||
                       /^https:\/\/lnkd\.in\/p\//.test(text))) state.url = text;
                }
              }).catch(() => {}).finally(() => { state.pending--; });
          }
          return result;
        } });
      }
      if (typeof document.execCommand === 'function') {
        const original = document.execCommand;
        hooks.push({ target: document, method: 'execCommand', descriptor: Object.getOwnPropertyDescriptor(document, 'execCommand') });
        Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: function(command) {
          if (String(command).toLowerCase() !== 'copy') return Reflect.apply(original, this, arguments);
          const element = document.activeElement;
          let selected = '';
          try {
            if (typeof element?.value === 'string' &&
                typeof element.selectionStart === 'number' && typeof element.selectionEnd === 'number') {
              selected = element.value.slice(element.selectionStart, element.selectionEnd);
            } else selected = window.getSelection?.()?.toString() || '';
          } catch {}
          const before = state.count;
          const result = Reflect.apply(original, this, arguments);
          // An explicit copy-event payload takes precedence if the page supplied one.
          if (state.count === before) record('execCommand', selected);
          return result;
        } });
      }
      document.addEventListener('copy', onCopy);
      window[key] = state;
      state.timer = setTimeout(restore, 15000);
      return true;
    } catch { try { restore(); } catch {} return false; }
  })()`;
  if (value(await args.evaluate(install).catch(() => undefined)) !== true) {
    args.onFailure?.({ stage: "install" });
    return undefined;
  }
  let identity: CapturedCopyLink | undefined;
  let failure: CopyCaptureFailure = { stage: "read" };
  let clicked = false;
  try {
    if (!args.stopped()) {
      failure = { stage: "click" };
      await args.click();
      clicked = true;
      failure = { stage: "read" };
      for (let read = 0; read < MAX_READS; read++) {
        await args.wait();
        if (args.stopped()) { failure = { stage: "stopped" }; break; }
        const observed = value(await args.evaluate(`(() => {
          const state = window[${name}];
          return state ? { count: state.count, url: state.url, method: state.method, pending: state.pending } : null;
        })()`));
        if (!observed || typeof observed !== "object") continue;
        const result = observed as { count?: unknown; url?: unknown; method?: unknown; pending?: unknown };
        const writes = result.count === 0 ? "none" : result.count === 1 ? "one" :
          typeof result.count === "number" && result.count > 1 ? "many" : undefined;
        const method = ["none", "writeText", "write", "copy", "execCommand", "mixed"].includes(String(result.method))
          ? result.method as CopyCaptureFailure["method"] : undefined;
        failure = { stage: "read", ...(writes ? { writes } : {}), ...(method ? { method } : {}) };
        if (writes === "many") break;
        // Keep the hook through the whole bounded window. A later write would
        // make an early URL ambiguous even if two initial reads matched.
        if (read !== MAX_READS - 1 || writes !== "one" || result.pending !== 0) continue;
        const urn = typeof result.url === "string" ? directActivityUrn(result.url) : undefined;
        const shortUrl = typeof result.url === "string" ? directShortPostUrl(result.url) : undefined;
        identity = urn ? { urn } : shortUrl ? { shortUrl } : undefined;
        if (!identity) failure = { stage: "invalid-url", writes: "one", ...(method ? { method } : {}) };
      }
    } else failure = { stage: "stopped" };
  } catch { failure = { stage: clicked ? "read" : "click" }; }
  finally {
    try {
      const restored = value(await args.evaluate(`(() => {
        const state = window[${name}];
        return state && typeof state.restore === 'function' ? state.restore() : false;
      })()`));
      if (restored !== true) { identity = undefined; failure = { stage: "restore" }; }
    } catch { identity = undefined; failure = { stage: "restore" }; }
  }
  if (!identity) args.onFailure?.(failure);
  return identity;
}

import { describe, expect, it, vi } from "vitest";
import { captureCopyLinkIdentity } from "./clipboard-capture.js";

function harness() {
  const written: string[] = [];
  const itemsWritten: unknown[][] = [];
  const clipboard = {
    writeText: async (value: string) => { written.push(value); },
    write: async (items: unknown[]) => { itemsWritten.push(items); },
  };
  const original = clipboard.writeText;
  const originalWrite = clipboard.write;
  const document = new EventTarget();
  const page = { navigator: { clipboard }, document, setTimeout, clearTimeout };
  const evaluate = async (expression: string) => ({ result: {
    value: new Function("window", "navigator", "document", "setTimeout", "clearTimeout", `return ${expression}`)(
      page, page.navigator, document, setTimeout, clearTimeout,
    ) as unknown,
  } });
  return { clipboard, original, originalWrite, written, itemsWritten, document, evaluate };
}

describe("scoped Copy link capture", () => {
  it("reports only fixed capture stages and write counts on failure", async () => {
    const invalid = "https://lnkd.in/p/private-token?unsafe=1";
    for (const scenario of ["install", "click", "read", "invalid-url"] as const) {
      const h = harness();
      const failures: unknown[] = [];
      const evaluate = scenario === "install" ? async () => ({ result: { value: false } }) : h.evaluate;
      const result = await captureCopyLinkIdentity({
        evaluate,
        click: async () => {
          if (scenario === "click") throw new Error("private click error");
          if (scenario === "invalid-url") await h.clipboard.writeText(invalid);
        },
        wait: async () => {}, stopped: () => false,
        onFailure: (failure) => failures.push(failure),
      });
      expect(result).toBeUndefined();
      expect(failures).toEqual([{ stage: scenario, ...(scenario === "read" ? { writes: "none", method: "none" } :
        scenario === "invalid-url" ? { writes: "one", method: "writeText" } : {}) }]);
      expect(JSON.stringify(failures)).not.toContain("private");
    }
  });

  it("captures one canonical LinkedIn URL without changing the clipboard action", async () => {
    const h = harness();
    const url = "https://www.linkedin.com/feed/update/urn:li:activity:7506985844398911488/";
    const identity = await captureCopyLinkIdentity({
      evaluate: h.evaluate,
      click: () => h.clipboard.writeText(url),
      wait: async () => {},
      stopped: () => false,
    });
    expect(identity).toEqual({ urn: "urn:li:activity:7506985844398911488" });
    expect(h.written).toEqual([url]);
    expect(h.clipboard.writeText).toBe(h.original);
  });

  it("captures one current lnkd.in post short link without deriving an activity ID", async () => {
    const h = harness();
    const url = "https://lnkd.in/p/eQDXbx_h";
    const identity = await captureCopyLinkIdentity({
      evaluate: h.evaluate,
      click: () => h.clipboard.writeText(url),
      wait: async () => {},
      stopped: () => false,
    });
    expect(identity).toEqual({ shortUrl: url });
    expect(h.written).toEqual([url]);
    expect(h.clipboard.writeText).toBe(h.original);
  });

  it("waits for one delayed writeText from the clicked menu action", async () => {
    const h = harness();
    const url = "https://lnkd.in/p/eQDXbx_h";
    let waits = 0;
    const identity = await captureCopyLinkIdentity({
      evaluate: h.evaluate,
      click: async () => {},
      wait: async () => { if (++waits === 3) await h.clipboard.writeText(url); },
      stopped: () => false,
    });
    expect(identity).toEqual({ shortUrl: url });
    expect(waits).toBeGreaterThanOrEqual(3);
    expect(waits).toBeLessThanOrEqual(8);
    expect(h.written).toEqual([url]);
    expect(h.clipboard.writeText).toBe(h.original);
  });

  it("captures text/plain from ClipboardItem.write without changing its operation", async () => {
    const h = harness();
    const url = "https://lnkd.in/p/eQDXbx_h";
    const item = { types: ["text/plain"], getType: async () => new Blob([url], { type: "text/plain" }) };
    const identity = await captureCopyLinkIdentity({
      evaluate: h.evaluate,
      click: () => h.clipboard.write([item]),
      wait: async () => {}, stopped: () => false,
    });
    expect(identity).toEqual({ shortUrl: url });
    expect(h.itemsWritten).toEqual([[item]]);
    expect(h.clipboard.write).toBe(h.originalWrite);
  });

  it("captures a copy event's prepared text without changing the clipboard event", async () => {
    const h = harness();
    const url = "https://lnkd.in/p/eQDXbx_h";
    const values = new Map([["text/plain", url]]);
    const transfer = { getData: (type: string) => values.get(type) ?? "", setData: (type: string, value: string) => values.set(type, value) };
    const identity = await captureCopyLinkIdentity({
      evaluate: h.evaluate,
      click: async () => {
        const event = new Event("copy");
        Object.defineProperty(event, "clipboardData", { value: transfer });
        h.document.dispatchEvent(event);
      },
      wait: async () => {}, stopped: () => false,
    });
    expect(identity).toEqual({ shortUrl: url });
    expect(transfer.getData("text/plain")).toBe(url);
  });

  it("captures a selected URL when a page uses execCommand copy", async () => {
    const h = harness();
    const url = "https://lnkd.in/p/eQDXbx_h";
    const originalExec = vi.fn(() => true);
    const document = h.document as EventTarget & {
      activeElement: { value: string; selectionStart: number; selectionEnd: number };
      execCommand: (command: string) => boolean;
    };
    document.activeElement = { value: url, selectionStart: 0, selectionEnd: url.length };
    document.execCommand = originalExec;
    const identity = await captureCopyLinkIdentity({
      evaluate: h.evaluate,
      click: async () => { document.execCommand("copy"); },
      wait: async () => {}, stopped: () => false,
    });
    expect(identity).toEqual({ shortUrl: url });
    expect(originalExec).toHaveBeenCalledExactlyOnceWith("copy");
    expect(document.execCommand).toBe(originalExec);
  });

  it("bounds a no-write result and reports a safe method bucket", async () => {
    const h = harness();
    let waits = 0;
    const failures: unknown[] = [];
    expect(await captureCopyLinkIdentity({
      evaluate: h.evaluate, click: async () => {},
      wait: async () => { waits++; }, stopped: () => false,
      onFailure: (failure) => failures.push(failure),
    })).toBeUndefined();
    expect(waits).toBe(7);
    expect(failures).toEqual([{ stage: "read", writes: "none", method: "none" }]);
    expect(h.clipboard.writeText).toBe(h.original);
    expect(h.clipboard.write).toBe(h.originalWrite);
  });

  it("accepts the backend's full 1–128 character base64url short-token range", async () => {
    for (const token of ["a", "a".repeat(128)]) {
      const h = harness();
      const shortUrl = `https://lnkd.in/p/${token}`;
      expect(await captureCopyLinkIdentity({
        evaluate: h.evaluate, click: () => h.clipboard.writeText(shortUrl),
        wait: async () => {}, stopped: () => false,
      })).toEqual({ shortUrl });
      expect(h.clipboard.writeText).toBe(h.original);
    }
  });

  it("rejects a foreign or forged activity URL and restores the original method", async () => {
    for (const url of [
      "https://evil.example/posts/ada-activity-7506985844398911488-XyZ",
      "https://www.linkedin.com.evil.example/posts/ada-activity-7506985844398911488-XyZ",
      "https://www.linkedin.com/feed/update/urn:li:activity:7506985844398911488/extra",
      "https://lnkd.in.evil.example/p/eQDXbx_h",
      "https://lnkd.in/p/eQDXbx_h/extra",
      "https://lnkd.in/p/eQDXbx_h?redirect=https://evil.example",
      "https://lnkd.in/p/%2e%2e",
      `https://lnkd.in/p/${"a".repeat(129)}`,
    ]) {
      const h = harness();
      expect(await captureCopyLinkIdentity({
        evaluate: h.evaluate, click: () => h.clipboard.writeText(url), wait: async () => {}, stopped: () => false,
      })).toBeUndefined();
      expect(h.clipboard.writeText).toBe(h.original);
    }
  });

  it("rejects multiple writes even when one is a valid post link", async () => {
    const h = harness();
    expect(await captureCopyLinkIdentity({
      evaluate: h.evaluate,
      click: async () => {
        await h.clipboard.writeText("https://www.linkedin.com/feed/update/urn:li:activity:7506985844398911488/");
        await h.clipboard.writeText("another value");
      },
      wait: async () => {}, stopped: () => false,
    })).toBeUndefined();
    expect(h.clipboard.writeText).toBe(h.original);
  });

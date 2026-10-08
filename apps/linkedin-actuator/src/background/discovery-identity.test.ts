import { describe, expect, it } from "vitest";
import { locateCopyLinkAfterHydration, resolveVisibleDiscoveryIdentity, type CopyFailure } from "./discovery-identity.js";
import type { CapturedCopyLink } from "./clipboard-capture.js";

const urn = "urn:li:activity:7506985844398911488";
const item = { leadId: "lead-1", fingerprint: "v1-card" };

function harness() {
  const events: string[] = [];
  const args = {
    stopped: () => false,
    enabled: async () => true,
    visibleFingerprints: [item.fingerprint],
    pending: async () => ({ items: [item], processing: 0 }),
    locate: async () => ({ ok: true, rect: { x: 1, y: 2, width: 30, height: 20 } }),
    click: async () => { events.push("menu-click"); },
    wait: async () => {},
    readShareUrn: async (): Promise<{ ok: boolean; urn?: string; skipReason?: string }> =>
      ({ ok: false, skipReason: "embed-link-not-found" }),
    captureCopyLink: async (): Promise<CapturedCopyLink | undefined> => { events.push("copy-link"); return { urn }; },
    closeMenu: async () => { events.push("close"); },
    resolve: async (_item: typeof item, value: string) => { events.push(`resolve:${value}`); return { resolved: true, duplicate: false }; },
    resolveShortLink: async (_item: typeof item, shortUrl: string) => {
      events.push(`resolve-short:${shortUrl}`);
      return { resolved: true, duplicate: false };
    },
  };
  return { args, events };
}

describe("qualified visible post identity", () => {
  it("uses one Copy link capture after DOM menu links remain absent", async () => {
    const h = harness();
    expect(await resolveVisibleDiscoveryIdentity(h.args)).toBe("resolved");
    expect(h.events).toEqual(["menu-click", "copy-link", "close", `resolve:${urn}`]);
  });

  it("never clicks Copy link when a canonical DOM link exists", async () => {
    const h = harness();
    h.args.readShareUrn = async () => ({ ok: true, urn });
    expect(await resolveVisibleDiscoveryIdentity(h.args)).toBe("resolved");
    expect(h.events).toEqual(["menu-click", "close", `resolve:${urn}`]);
  });

  it("keeps an unresolved lead when Copy link returns no valid identity", async () => {
    const h = harness();
    h.args.captureCopyLink = async () => { h.events.push("copy-link"); return undefined; };
    expect(await resolveVisibleDiscoveryIdentity(h.args)).toBe("unresolved");
    expect(h.events).toEqual(["menu-click", "copy-link", "close"]);
  });

  it("reports a fixed locator reason and sanitized menu shape when Copy link cannot be found", async () => {
    const h = harness();
    const reports: unknown[] = [];
    const args = {
      ...h.args,
      captureCopyLink: async () => ({ failure: {
        stage: "locate" as const,
        locatorReason: "not-post-menu",
        menuDiagnostic: "expanded=true;totalMenus=5;menus=4;opened=1;updated=0;save=1;copy=0;menuitems=6;pageSave=1;pageCopy=0;pageMenuitems=6;outlet=closed;outletControls=0",
      } }),
      report: async (outcome: unknown) => { reports.push(outcome); },
    };
    expect(await resolveVisibleDiscoveryIdentity(args)).toBe("unresolved");
    expect(reports).toEqual([{
      result: "unresolved", reason: "copy-link-not-resolved",
      copy: { stage: "locate", locatorReason: "not-post-menu",
        menuDiagnostic: "expanded=true;totalMenus=5;menus=4;opened=1;updated=0;save=1;copy=0;menuitems=6;pageSave=1;pageCopy=0;pageMenuitems=6;outlet=closed;outletControls=0" },
    }]);
  });

  it("drops unexpected locator diagnostics before writing status", async () => {
    const h = harness();
    const reports: unknown[] = [];
    const args = {
      ...h.args,
      captureCopyLink: async () => ({ failure: {
        stage: "locate" as const, locatorReason: "private-token",
        menuDiagnostic: "expanded=true;url=https://lnkd.in/p/private-token",
      } }),
      report: async (outcome: unknown) => { reports.push(outcome); },
    };
    expect(await resolveVisibleDiscoveryIdentity(args)).toBe("unresolved");
    expect(reports).toEqual([{ result: "unresolved", reason: "copy-link-not-resolved", copy: { stage: "locate" } }]);
  });

  it("reports only allowlisted clipboard method buckets", async () => {
    for (const [input, expected] of [["write", "write"], ["private-value", undefined]] as const) {
      const h = harness();
      const reports: unknown[] = [];
      const args = {
        ...h.args,
        captureCopyLink: async () => ({ failure: {
          stage: "read" as const, writes: "one" as const, method: input,
        } as unknown as CopyFailure }),
        report: async (outcome: unknown) => { reports.push(outcome); },
      };
      expect(await resolveVisibleDiscoveryIdentity(args)).toBe("unresolved");
      expect(reports).toEqual([{ result: "unresolved", reason: "copy-link-not-resolved",
        copy: { stage: "read", writes: "one", ...(expected ? { method: expected } : {}) } }]);
    }
  });

  it("submits one captured lnkd.in post URL for backend canonical resolution", async () => {
    const h = harness();
    const shortUrl = "https://lnkd.in/p/eQDXbx_h";
    h.args.captureCopyLink = async () => { h.events.push("copy-link"); return { shortUrl }; };
    expect(await resolveVisibleDiscoveryIdentity(h.args)).toBe("resolved");
    expect(h.events).toEqual(["menu-click", "copy-link", "close", `resolve-short:${shortUrl}`]);
  });

  it("keeps the lead pending when backend short-link resolution is unavailable", async () => {
    const h = harness();
    h.args.captureCopyLink = async () => ({ shortUrl: "https://lnkd.in/p/eQDXbx_h" });
    h.args.resolveShortLink = async () => { throw new Error("503"); };
    expect(await resolveVisibleDiscoveryIdentity(h.args)).toBe("unresolved");
    expect(h.events).toEqual(["menu-click", "close"]);
  });

  it("does not submit a forged short-link capture", async () => {
    const h = harness();
    h.args.captureCopyLink = async () => ({ shortUrl: "https://lnkd.in.evil.example/p/fake" });
    expect(await resolveVisibleDiscoveryIdentity(h.args)).toBe("unresolved");
    expect(h.events).toEqual(["menu-click", "close"]);
  });

  it("never clicks Copy link after any ambiguous menu read, even if a later read looks empty", async () => {
    for (const skipReason of ["ambiguous-menu-activity", "ambiguous-menu-share", "ambiguous-open-menu"]) {
      const h = harness();
      let reads = 0;
      h.args.readShareUrn = async () => ({ ok: false, skipReason: reads++ === 0 ? skipReason : "embed-link-not-found" });
      expect(await resolveVisibleDiscoveryIdentity(h.args)).toBe("unresolved");
      expect(h.events).toEqual(["menu-click", "close"]);
    }
  });
});

describe("hydrating Copy control", () => {
  const rect = { x: 5, y: 6, width: 50, height: 22 };

  it("finds a delayed Copy control with DOM reads only", async () => {
    const events: string[] = [];
    let reads = 0;
    const found = await locateCopyLinkAfterHydration({
      isCurrent: async () => true,
      locate: async () => {
        events.push("locate");
        return ++reads === 3 ? { ok: true, rect } : { ok: false, skipReason: "not-post-menu" };
      },
      wait: async () => { events.push("wait"); },
    });
    expect(found).toEqual({ ok: true, rect });
    expect(events).toEqual(["locate", "wait", "locate", "wait", "locate"]);
  });

  it("never accepts a later control after an ambiguous menu read", async () => {
    let reads = 0;
    let waits = 0;
    const found = await locateCopyLinkAfterHydration({
      isCurrent: async () => true,
      locate: async () => ++reads === 1
        ? { ok: false, skipReason: "ambiguous-open-menu" }
        : { ok: true, rect },
      wait: async () => { waits++; },
    });
    expect(found).toEqual({ ok: false, skipReason: "ambiguous-open-menu" });
    expect(reads).toBe(1);
    expect(waits).toBe(0);
  });

  it("stops after eight reads and retains the final diagnostic", async () => {
    let reads = 0;
    let waits = 0;
    const found = await locateCopyLinkAfterHydration({
      isCurrent: async () => true,
      locate: async () => ({ ok: false, skipReason: "not-post-menu", diagnostic: `sample-${++reads}` }),
      wait: async () => { waits++; },
    });
    expect(found).toEqual({ ok: false, skipReason: "not-post-menu", diagnostic: "sample-8" });
    expect(waits).toBe(7);
  });

  it("does not read again after STOP or a challenge appears", async () => {
    let checks = 0;
    let reads = 0;
    const found = await locateCopyLinkAfterHydration({
      isCurrent: async () => ++checks < 2,
      locate: async () => { reads++; return { ok: false, skipReason: "not-post-menu" }; },
      wait: async () => {},
    });
    expect(found).toEqual({ ok: false, skipReason: "stopped" });
    expect(reads).toBe(1);
  });

  it("fails closed if a run gate cannot be checked", async () => {
    let reads = 0;
    const found = await locateCopyLinkAfterHydration({
      isCurrent: async () => { throw new Error("gate error"); },
      locate: async () => { reads++; return { ok: true, rect }; },
      wait: async () => {},
    });
    expect(found).toEqual({ ok: false, skipReason: "stopped" });
    expect(reads).toBe(0);
  });
});

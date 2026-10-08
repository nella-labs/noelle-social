import { describe, expect, it, vi } from "vitest";
import { resolveVisibleDiscoveryIdentity } from "../src/background/discovery-identity.js";

const pending = [{ leadId: "lead-1", fingerprint: "author:full-post" }];

function deps() {
  return {
    stopped: () => false,
    enabled: async () => true,
    visibleFingerprints: ["author:full-post"],
    pending: vi.fn(async () => ({ items: pending, processing: 0 })),
    locate: vi.fn(async (): Promise<{ ok: boolean; rect?: { x: number; y: number; width: number; height: number }; skipReason?: string }> =>
      ({ ok: true, rect: { x: 10, y: 20, width: 20, height: 20 } })),
    click: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    readShareUrn: vi.fn(async (): Promise<{ ok: boolean; urn?: string; skipReason?: string; diagnostic?: string }> =>
      ({ ok: true, urn: "urn:li:share:7506985844398911488" })),
    closeMenu: vi.fn(async () => {}),
    resolve: vi.fn(async () => ({ resolved: true, duplicate: false })),
    report: vi.fn(async (_outcome: { result: string; reason?: string }) => {}),
  };
}

describe("qualified discovery identity", () => {
  it("opens one matching card menu at an ambient slot and resolves its share URN", async () => {
    const args = deps();
    expect(await resolveVisibleDiscoveryIdentity(args)).toBe("resolved");
    expect(args.pending).toHaveBeenCalledWith(["author:full-post"]);
    expect(args.locate).toHaveBeenCalledWith("author:full-post");
    expect(args.click).toHaveBeenCalledOnce();
    expect(args.resolve).toHaveBeenCalledWith(pending[0], "urn:li:share:7506985844398911488");
    expect(args.closeMenu).toHaveBeenCalledOnce();
  });

  it("resolves two qualified visible cards in the same paced read", async () => {
    const args = deps();
    const second = { leadId: "lead-2", fingerprint: "author:second-post" };
    args.visibleFingerprints.push(second.fingerprint);
    args.pending.mockResolvedValue({ items: [...pending, second], processing: 0 });
    expect(await resolveVisibleDiscoveryIdentity(args)).toBe("resolved");
    expect(args.pending).toHaveBeenCalledExactlyOnceWith(args.visibleFingerprints);
    expect(args.locate).toHaveBeenCalledTimes(2);
    expect(args.click).toHaveBeenCalledTimes(2);
    expect(args.resolve).toHaveBeenCalledTimes(2);
    expect(args.closeMenu).toHaveBeenCalledTimes(2);
  });

  it("keeps the current visibility window while another staged card is classifying", async () => {
    const args = deps();
    const second = { leadId: "lead-2", fingerprint: "author:second-post" };
    args.visibleFingerprints.push(second.fingerprint);
    args.pending.mockResolvedValueOnce({ items: pending, processing: 1 })
      .mockResolvedValueOnce({ items: [...pending, second], processing: 0 });
    const attempted = new Set<string>();
    expect(await resolveVisibleDiscoveryIdentity({ ...args, attempted })).toBe("classifying");
    expect(await resolveVisibleDiscoveryIdentity({ ...args, attempted })).toBe("resolved");
    expect(args.click).toHaveBeenCalledTimes(2);
    expect(args.resolve).toHaveBeenCalledTimes(2);
    expect(attempted).toEqual(new Set(["lead-1", "lead-2"]));
  });

  it("continues with another visible card after a transient identity API error", async () => {
    const args = deps();
    const second = { leadId: "lead-2", fingerprint: "author:second-post" };
    args.visibleFingerprints.push(second.fingerprint);
    args.pending.mockResolvedValue({ items: [...pending, second], processing: 0 });
    args.resolve.mockRejectedValueOnce(new Error("identity_unavailable"))
      .mockResolvedValueOnce({ resolved: true, duplicate: false });
    expect(await resolveVisibleDiscoveryIdentity(args)).toBe("resolved");
    expect(args.click).toHaveBeenCalledTimes(2);
    expect(args.closeMenu).toHaveBeenCalledTimes(2);
    expect(args.report).toHaveBeenCalledWith({ result: "unresolved", reason: "identity-resolve-failed" });
    expect(args.resolve).toHaveBeenLastCalledWith(second, "urn:li:share:7506985844398911488");
  });

  it("continues to another qualified visible card after one menu has no verified link", async () => {
    const args = deps();
    const second = { leadId: "lead-2", fingerprint: "author:second-post" };
    args.visibleFingerprints.push(second.fingerprint);
    args.pending.mockResolvedValue({ items: [...pending, second], processing: 0 });
    args.readShareUrn.mockResolvedValueOnce({ ok: false, skipReason: "embed-link-not-found" })
      .mockResolvedValueOnce({ ok: false, skipReason: "embed-link-not-found" })
      .mockResolvedValueOnce({ ok: false, skipReason: "embed-link-not-found" })
      .mockResolvedValueOnce({ ok: true, urn: "urn:li:activity:7506985844398911488" });
    expect(await resolveVisibleDiscoveryIdentity(args)).toBe("resolved");
    expect(args.click).toHaveBeenCalledTimes(2);
    expect(args.resolve).toHaveBeenCalledExactlyOnceWith(second, "urn:li:activity:7506985844398911488");
    expect(args.closeMenu).toHaveBeenCalledTimes(2);
    expect(args.report).toHaveBeenCalledWith({ result: "unresolved", reason: "embed-link-not-found" });
    expect(args.report).toHaveBeenCalledWith({ result: "resolved" });
  });

  it("never opens more than five qualified menus or continues after STOP", async () => {
    const args = deps();
    const candidates = Array.from({ length: 7 }, (_, index) => ({
      leadId: `lead-${index}`, fingerprint: `post-${index}`,
    }));
    args.visibleFingerprints = candidates.map((item) => item.fingerprint);
    args.pending.mockResolvedValue({ items: candidates, processing: 0 });
    expect(await resolveVisibleDiscoveryIdentity(args)).toBe("resolved");
    expect(args.click).toHaveBeenCalledTimes(5);

    let stopped = false;
    args.click.mockClear();
    args.resolve.mockImplementation(async () => { stopped = true; return { resolved: true, duplicate: false }; });
    args.stopped = () => stopped;
    expect(await resolveVisibleDiscoveryIdentity(args)).toBe("stopped");
    expect(args.click).toHaveBeenCalledTimes(1);
  });

  it("does not open a menu for rejected or unavailable candidates", async () => {
    const args = deps();
    args.pending.mockResolvedValue({ items: [], processing: 0 });
    expect(await resolveVisibleDiscoveryIdentity(args)).toBe("none");
    expect(args.click).not.toHaveBeenCalled();
    args.pending.mockResolvedValue({ items: pending, processing: 0 });
    args.locate.mockResolvedValue({ ok: false, rect: { x: 0, y: 0, width: 0, height: 0 } });
    expect(await resolveVisibleDiscoveryIdentity(args)).toBe("not-visible");
    expect(args.click).not.toHaveBeenCalled();
  });

  it("does not query the pending backlog when the current read has no cards", async () => {
    const args = deps();
    args.visibleFingerprints = [];
    expect(await resolveVisibleDiscoveryIdentity(args)).toBe("none");
    expect(args.pending).not.toHaveBeenCalled();
    expect(args.click).not.toHaveBeenCalled();
  });

  it("closes the menu and keeps the lead pending when no share URN appears", async () => {
    const args = deps();
    args.readShareUrn.mockResolvedValue({ ok: false, urn: "", skipReason: "embed-link-not-found", diagnostic: "menuitem:copy-link" });
    expect(await resolveVisibleDiscoveryIdentity(args)).toBe("unresolved");
    expect(args.resolve).not.toHaveBeenCalled();
    expect(args.closeMenu).toHaveBeenCalledOnce();
    expect(args.readShareUrn).toHaveBeenCalledTimes(3);
    expect(args.report).toHaveBeenCalledWith({ result: "unresolved", reason: "embed-link-not-found", diagnostic: "menuitem:copy-link" });
  });

  it("preserves a bounded redacted menu shape beyond the old 300-character limit", async () => {
    const args = deps();
    const diagnostic = "shape=" + "x".repeat(700);
    args.readShareUrn.mockResolvedValue({ ok: false, skipReason: "embed-link-not-found", diagnostic });
    expect(await resolveVisibleDiscoveryIdentity(args)).toBe("unresolved");
    expect(args.report).toHaveBeenCalledWith({
      result: "unresolved",
      reason: "embed-link-not-found",
      diagnostic: diagnostic.slice(0, 600),
    });
  });

  it("waits for a hydrated share menu within the same read slot", async () => {
    const args = deps();
    args.readShareUrn
      .mockResolvedValueOnce({ ok: false, skipReason: "embed-link-not-found" })
      .mockResolvedValueOnce({ ok: true, urn: "urn:li:share:7506985844398911488" });
    expect(await resolveVisibleDiscoveryIdentity(args)).toBe("resolved");
    expect(args.click).toHaveBeenCalledOnce();
    expect(args.wait).toHaveBeenCalledTimes(2);
    expect(args.readShareUrn).toHaveBeenCalledTimes(2);
    expect(args.closeMenu).toHaveBeenCalledOnce();
    expect(args.report).toHaveBeenCalledWith({ result: "resolved" });
  });

  it("remeasures a zero-rectangle menu after layout and reports a missing card", async () => {
    const args = deps();
    args.locate.mockResolvedValueOnce({ ok: false, skipReason: "post-menu-zero-rect" })
      .mockResolvedValueOnce({ ok: true, rect: { x: 10, y: 20, width: 20, height: 20 } });
    expect(await resolveVisibleDiscoveryIdentity(args)).toBe("resolved");
    expect(args.locate).toHaveBeenCalledTimes(2);
    expect(args.click).toHaveBeenCalledOnce();

    args.locate.mockReset().mockResolvedValue({ ok: false, skipReason: "qualified-post-not-visible" });
    args.click.mockClear();
    expect(await resolveVisibleDiscoveryIdentity(args)).toBe("not-visible");
    expect(args.click).not.toHaveBeenCalled();
    expect(args.report).toHaveBeenLastCalledWith({ result: "not-visible", reason: "qualified-post-not-visible" });
  });

  it("honors STOP before touching the browser", async () => {
    const args = deps();
    args.stopped = () => true;
    expect(await resolveVisibleDiscoveryIdentity(args)).toBe("stopped");
    expect(args.pending).not.toHaveBeenCalled();
    expect(args.click).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ read: vi.fn(), fetch: vi.fn() }));
vi.mock("react", () => ({ cache: <T>(fn: T) => fn }));
vi.mock("@/lib/db", () => ({ readSql: fixture.read, pgOrgMembersClient: () => ({}) }));
vi.mock("@noelle/runtime", () => ({ assertOrgMember: async () => {} }));
vi.mock("@/lib/auth-cookie", () => ({ getUserFromCookies: async () => ({ id: "fixture-member" }) }));
vi.mock("@/lib/api", () => ({ noelleFetch: fixture.fetch }));
import { getPostThread, listContentMediaForOrg } from "./posts-queries";
const org = "00000000-0000-4000-8000-000000000001", instance = "00000000-0000-4000-8000-000000000011";
const id = "00000000-0000-4000-8000-000000000031", ideaId = "00000000-0000-4000-8000-000000000041";
const expired = "https://storage.googleapis.com/fixture/one?X-Goog-Signature=expired", fresh = "https://storage.googleapis.com/fixture/one?fresh=1";
const media = { id, url: expired, status: "ready", kind: "image" };
let now = 0;
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  fixture.fetch.mockReset().mockResolvedValue({ media: [{ id, url: fresh }] });
  fixture.read.mockReset().mockImplementation((strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("from noelle.content_media")) return Promise.resolve([{ ...media }]);
    if (query.includes("from noelle.post_ideas where id")) return Promise.resolve([{ id: ideaId, org_id: org, agent_instance_id: instance }]);
    return Promise.resolve([]);
  });
});
describe("dashboard current media capabilities", () => {
  it.each(["library", "thread"])("refreshes %s preview and copy URLs through the existing JWT read flow", async lane => {
    const rows = lane === "library" ? await listContentMediaForOrg(org) : (await getPostThread(ideaId))!.media;
    expect(rows[0]?.url).toBe(fresh);
    expect(fixture.fetch).toHaveBeenCalledWith("/api/content-media/resolve", {
      method: "POST", body: { orgId: org, ids: [id] }, timeoutMs: 30_000,
    });
  });
  it("does not present an expired capability after refresh failure", async () => {
    fixture.fetch.mockRejectedValueOnce(Error("read unavailable"));
    expect((await listContentMediaForOrg(org))[0]?.url).toBeNull();
  });
  it("does not start another signing batch after the overall read deadline", async () => {
    const ids = Array.from({ length: 5 }, (_, index) => `00000000-0000-4000-8000-${String(index + 31).padStart(12, "0")}`);
    fixture.read.mockResolvedValue(ids.map(id => ({ ...media, id })));
    fixture.fetch.mockImplementationOnce(async () => { now = 30_000; return { media: [{ id: ids[0], url: fresh }] }; });
    const rows = await listContentMediaForOrg(org);
    expect(fixture.fetch).toHaveBeenCalledOnce();
    expect(rows[0]?.url).toBe(fresh); expect(rows.slice(1).map(row => row.url)).toEqual([null, null, null, null]);
  });
  it("gives subsequent batches only the remaining response-body deadline", async () => {
    const ids = Array.from({ length: 5 }, (_, index) => `00000000-0000-4000-8000-${String(index + 31).padStart(12, "0")}`);
    fixture.read.mockResolvedValue(ids.map(id => ({ ...media, id })));
    fixture.fetch.mockImplementationOnce(async () => { now = 12_000; return { media: [] }; });
    await listContentMediaForOrg(org);
    expect(fixture.fetch.mock.calls[1]?.[1]).toMatchObject({ timeoutMs: 18_000 });
  });
  it("keeps existing relative local media links usable without a remote refresh", async () => {
    fixture.read.mockResolvedValue([{ ...media, url: "/media/one.png" }]);
    expect((await listContentMediaForOrg(org))[0]?.url).toBe("/media/one.png"); expect(fixture.fetch).not.toHaveBeenCalled();
  });
});

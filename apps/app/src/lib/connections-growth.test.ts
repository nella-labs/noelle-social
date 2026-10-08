import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  requests: [] as Array<{ pageSize?: number; pageToken?: string; filter?: string }>,
  disabled: [] as string[],
  latest: 3,
  versions: [] as Array<{
    name: string;
    state: "ENABLED" | "DISABLED";
    createTime: { seconds: string; nanos: number };
  }>,
  page: 0,
  active: 0,
  peak: 0,
  stale: false,
}));
const name = "projects/noelle-agents/secrets/noelle--org--org--gemini-api-key";
vi.mock("./sm", () => ({
  SM_PROJECT: "noelle-agents",
  getSecretManagerClient: async () => ({
    getSecret: async () => [{ name }],
    accessSecretVersion: async () => [{ payload: { data: Buffer.from("fixture-value") } }],
    createSecret: async () => [{ name }],
    addSecretVersion: async () => [{ name: `${name}/versions/${fixture.latest}` }],
    listSecretVersions: async (request: {
      pageSize?: number;
      pageToken?: string;
      filter?: string;
    }) => {
      fixture.requests.push(request);
      const versions = request.filter
        ? fixture.versions.filter((v) => v.state === "ENABLED")
        : fixture.versions;
      const offset = Number(request.pageToken ?? 0),
        size = request.pageSize ?? versions.length;
      const selected = versions.slice(offset, offset + size);
      return [
        selected,
        undefined,
        { nextPageToken: offset + size < versions.length ? String(offset + size) : "" },
      ];
    },
    disableSecretVersion: async ({ name: id }: { name: string }) => {
      fixture.active++;
      fixture.peak = Math.max(fixture.peak, fixture.active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      fixture.disabled.push(id);
      if (!fixture.stale) fixture.versions.find((v) => v.name === id)!.state = "DISABLED";
      fixture.active--;
      return [{ name: id }];
    },
  }),
}));
import { disableConnection, getConnectionStatus, setConnectionValue } from "./connections";
beforeEach(() => {
  fixture.requests = [];
  fixture.disabled = [];
  fixture.latest = 3;
  fixture.active = 0;
  fixture.peak = 0;
  fixture.stale = false;
  fixture.versions = Array.from({ length: 205 }, (_, i) => ({
    name: `${name}/versions/${205 - i}`,
    state: "ENABLED" as const,
    createTime: { seconds: "1700000000", nanos: 0 },
  }));
});
it("reads one latest enabled version for a connection preview", async () => {
  expect((await getConnectionStatus("org", "gemini")).status).toBe("connected");
  expect(fixture.requests).toEqual([expect.objectContaining({ pageSize: 1 })]);
});
it("does not disable its acknowledged version or a concurrent newer version", async () => {
  fixture.versions = [4, 3, 2, 1].map((id) => ({
    name: `${name}/versions/${id}`,
    state: "ENABLED" as const,
    createTime: { seconds: "1700000000", nanos: 0 },
  }));
  await setConnectionValue("org", "gemini", `AIza${"x".repeat(35)}`);
  expect(fixture.disabled).toEqual([`${name}/versions/2`, `${name}/versions/1`]);
});
it("drains all205 versions through bounded pages and four mutation workers", async () => {
  await disableConnection("org", "gemini");
  expect(fixture.disabled).toHaveLength(205);
  expect(fixture.versions.every((v) => v.state === "DISABLED")).toBe(true);
  expect(fixture.requests).toHaveLength(3);
  expect(fixture.requests.every((request) => !request.filter)).toBe(true);
  expect(fixture.peak).toBeLessThanOrEqual(4);
  expect(fixture.requests.every((request) => request.pageSize === 100)).toBe(true);
});
it("does not replay acknowledged disables while list state is stale", async () => {
  fixture.stale = true;
  await disableConnection("org", "gemini");
  expect(fixture.disabled).toHaveLength(205);
  expect(new Set(fixture.disabled).size).toBe(205);
  expect(fixture.requests).toHaveLength(3);
});
it("skips disabled historical versions without changing pagination", async () => {
  fixture.versions[0]!.state = "DISABLED";
  await disableConnection("org", "gemini");
  expect(fixture.disabled).toHaveLength(204);
  expect(fixture.disabled).not.toContain(`${name}/versions/205`);
  expect(fixture.requests).toHaveLength(3);
});

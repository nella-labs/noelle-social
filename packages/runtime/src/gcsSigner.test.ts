import { afterEach, expect, it, vi } from "vitest";
import { createGcsSigner } from "./gcsSigner.js";

vi.mock("@google-cloud/storage", async importOriginal => {
  const { Storage } = await importOriginal<typeof import("@google-cloud/storage")>();
  return { Storage: class extends Storage {
    constructor(options: ConstructorParameters<typeof Storage>[0] = {}) {
      super({ ...options, projectId: "fixture" });
      this.authClient.getCredentials = async () => { throw Error("SDK metadata fallback"); };
      this.authClient.sign = async () => { throw Error("SDK signing fallback"); };
      this.authClient.getAccessToken = async () => { throw Error("SDK token fallback"); };
    }
  } };
});
afterEach(() => vi.restoreAllMocks());
const args = { version: "v4" as const, action: "write" as const, contentType: "text/markdown", expires: Date.now() + 600_000 };
const signature = Buffer.from("fixture-signature").toString("base64");

it("keeps concurrent SDK signing calls on their own original deadlines", async () => {
  let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  const releases: Array<() => void> = [];
  const getCredentials = vi.fn(async () => {
    await new Promise<void>(resolve => { releases.push(resolve); });
    return { client_email: "fixture@example.invalid" };
  });
  const sign = vi.fn(async (_data: string, _endpoint?: string, _timeoutMs?: number) => signature);
  const signer = createGcsSigner({ timeoutMs: 1000, credentials: { getCredentials, sign, getAccessToken: vi.fn() } });
  const first = signer.getSignedUrl("fixture", "tenant/a.md", args);
  now = 400;
  const second = signer.getSignedUrl("fixture", "tenant/b.md", args);
  try {
    await vi.waitFor(() => expect(releases).toHaveLength(2)); now = 700;
    releases.forEach(release => release());
    const results = await Promise.all([first, second]);
    expect(getCredentials.mock.calls).toEqual([[1000], [1000]]);
    expect(sign.mock.calls.map(call => call[2])).toEqual([300, 700]);
    expect(results.map(([url]) => new URL(url).pathname)).toEqual(["/fixture/tenant/a.md", "/fixture/tenant/b.md"]);
    expect(new URL(results[0]![0]).searchParams.get("X-Goog-Signature")).toBe(Buffer.from("fixture-signature").toString("hex"));
  } finally { releases.forEach(release => release()); await Promise.allSettled([first, second]); }
});

it("does not start signing after credential metadata consumes the original budget", async () => {
  let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  const getCredentials = vi.fn(async () => { now = 101; return { client_email: "fixture@example.invalid" }; });
  const sign = vi.fn(async () => signature);
  const signer = createGcsSigner({ timeoutMs: 100, credentials: { getCredentials, sign, getAccessToken: vi.fn() } });
  await expect(signer.getSignedUrl("fixture", "tenant/a.md", args)).rejects.toThrow(/timeout/);
  expect(sign).not.toHaveBeenCalled();
});

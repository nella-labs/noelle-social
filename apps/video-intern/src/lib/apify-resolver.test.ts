import { expect, it, vi } from "vitest";
import { createApifyResolver } from "./apify-resolver.js";

vi.mock("@noelle/video-apify", async importOriginal => {
  const actual = await importOriginal<typeof import("@noelle/video-apify")>();
  return { ...actual, checkApifyToken: vi.fn() };
});
vi.mock("./connections-db.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./connections-db.js")>();
  return { ...actual, markApifyTokenInvalid: vi.fn().mockResolvedValue(true) };
});
vi.mock("./apify-rotating.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./apify-rotating.js")>();
  return { ...actual, createRotatingApifyClient: vi.fn(actual.createRotatingApifyClient) };
});

it("binds the resolved Video org and stored key to its reactive invalidation", async () => {
  const db = await import("./connections-db.js");
  const { checkApifyToken } = await import("@noelle/video-apify");
  const rotation = await import("./apify-rotating.js");
  vi.mocked(checkApifyToken).mockResolvedValue({ alive: false, httpStatus: 401 });
  const resolve = createApifyResolver({
    sql: (() => Promise.resolve([{ id: "captured-id", secret: " captured-key ",
      exhausted: false, available: true }])) as never,
    secrets: { get: vi.fn() }, apifyTokenSecretId: "fixture", log: { warn: vi.fn() },
  });
  await resolve("actual-org");
  const callback = vi.mocked(rotation.createRotatingApifyClient).mock.calls[0]?.[0].onTokenFatal;
  expect(callback).toBeTypeOf("function");
  callback!("captured-id", 401, " captured-key ");
  await vi.waitFor(() => expect(db.markApifyTokenInvalid).toHaveBeenCalledWith(expect.anything(), {
    orgId: "actual-org", credentialId: "captured-id", token: " captured-key ",
  }));
});

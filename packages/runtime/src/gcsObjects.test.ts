import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createGcsObjectClient } from "./gcsObjects.js";

it("captures the accepted object identity and byte source before awaiting credentials", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const bytes = new Uint8Array([1, 2, 3]);
  const args = { bucket: "fixture", name: "tenant/a.png", bytes, contentType: "image/png" };
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(new URL(String(input)).searchParams.get("name")).toBe("tenant/a.png");
    expect(new Headers(init?.headers).get("content-type")).toBe("image/png");
    expect(init?.body).toEqual(Buffer.from(bytes));
    return Response.json({ bucket: "fixture", name: "tenant/a.png", size: "3",
      md5Hash: createHash("md5").update(bytes).digest("base64") });
  });
  const pending = createGcsObjectClient({ getAccessToken: async () => { await gate; return "fixture"; }, fetchImpl }).write(args);
  try {
    args.bucket = "foreign"; args.name = "foreign/b.png"; args.contentType = "text/plain";
    args.bytes = new Uint8Array(17 * 1024 * 1024);
    release(); await pending;
    expect(fetchImpl).toHaveBeenCalledOnce();
  } finally { release(); await pending.catch(() => {}); }
});

it("rejects mutation of accepted bytes while credentials are pending before HTTP dispatch", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const bytes = new Uint8Array([1, 2, 3]), fetchImpl = vi.fn();
  const pending = createGcsObjectClient({ getAccessToken: async () => { await gate; return "fixture"; }, fetchImpl })
    .write({ bucket: "fixture", name: "tenant/a.png", bytes, contentType: "image/png" });
  try {
    bytes[0] = 9; release();
    await expect(pending).rejects.toThrow("source changed before dispatch");
    expect(fetchImpl).not.toHaveBeenCalled();
  } finally { release(); await pending.catch(() => {}); }
});

it("rejects the upload byte cap before asking for credentials", async () => {
  const getAccessToken = vi.fn(async () => "fixture"), fetchImpl = vi.fn();
  await expect(createGcsObjectClient({ getAccessToken, fetchImpl })
    .write({ bucket: "fixture", name: "tenant/a.png", bytes: new Uint8Array(16 * 1024 * 1024 + 1), contentType: "image/png" }))
    .rejects.toThrow(/byte limit/);
  expect(getAccessToken).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
});

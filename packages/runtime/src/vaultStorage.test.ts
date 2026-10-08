import { describe, it, expect, vi } from "vitest";
import { createVaultStorage, type StorageDeps } from "./vaultStorage.js";

interface FakeFile {
  getSignedUrl: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
}

interface FakeBucket {
  file: ReturnType<typeof vi.fn>;
  getFiles: ReturnType<typeof vi.fn>;
}

function makeDeps(): { deps: StorageDeps; fakeBucket: FakeBucket; fakeFile: FakeFile } {
  const fakeFile: FakeFile = {
    getSignedUrl: vi.fn(async () => ["https://signed.example/put"]),
    delete: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
    download: vi.fn(async () => [Buffer.from("# hello\n")]),
  };
  const fakeBucket: FakeBucket = {
    file: vi.fn(() => fakeFile),
    getFiles: vi.fn(async () => [
      [
        { name: "demooperator/posts/a.md", metadata: { size: "12", updated: "2026-05-25T00:00:00Z", md5Hash: "abc==" } },
        { name: "demooperator/posts/b.md", metadata: { size: "30", updated: "2026-05-24T00:00:00Z", md5Hash: "def==" } },
      ],
    ]),
  };
  const deps: StorageDeps = {
    bucket() {
      return fakeBucket as never;
    },
  };
  return { deps, fakeBucket, fakeFile };
}

describe("vaultStorage", () => {
  it("lists files under a prefix with size+updated metadata", async () => {
    const { deps, fakeBucket } = makeDeps();
    const storage = createVaultStorage(deps);
    const files = await storage.list({ bucket: "noelle-vaults", prefix: "demooperator/" });
    expect(fakeBucket.getFiles).toHaveBeenCalledWith({ prefix: "demooperator/", autoPaginate: false,
      maxResults: 100, timeoutMs: expect.any(Number) });
    expect(files).toEqual([
      { path: "demooperator/posts/a.md", size: 12, updatedISO: "2026-05-25T00:00:00Z", md5: "abc==" },
      { path: "demooperator/posts/b.md", size: 30, updatedISO: "2026-05-24T00:00:00Z", md5: "def==" },
    ]);
  });

  it("readText downloads the object body at the resolved path", async () => {
    const { deps, fakeBucket, fakeFile } = makeDeps();
    const storage = createVaultStorage(deps);
    const body = await storage.readText({
      bucket: "noelle-vaults",
      prefix: "demooperator/",
      filename: "posts/a.md",
    });
    expect(fakeBucket.file).toHaveBeenCalledWith("demooperator/posts/a.md");
    expect(fakeFile.download).toHaveBeenCalled();
    expect(body).toBe("# hello\n");
  });

  it("readText enforces the safe-filename rule", async () => {
    const { deps } = makeDeps();
    const storage = createVaultStorage(deps);
    await expect(
      storage.readText({ bucket: "noelle-vaults", prefix: "demooperator/", filename: "../x.md" }),
    ).rejects.toThrow(/path traversal/);
  });

  it("returns a signed PUT URL for an in-prefix filename", async () => {
    const { deps, fakeBucket, fakeFile } = makeDeps();
    const storage = createVaultStorage(deps);
    const url = await storage.signUpload({
      bucket: "noelle-vaults",
      prefix: "demooperator/",
      filename: "posts/c.md",
      contentType: "text/markdown",
    });
    expect(url).toBe("https://signed.example/put");
    expect(fakeBucket.file).toHaveBeenCalledWith("demooperator/posts/c.md");
    expect(fakeFile.getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        version: "v4",
        action: "write",
        contentType: "text/markdown",
      }),
    );
  });

  it("rejects filenames that contain `..` (path traversal)", async () => {
    const { deps } = makeDeps();
    const storage = createVaultStorage(deps);
    await expect(
      storage.signUpload({
        bucket: "noelle-vaults",
        prefix: "demooperator/",
        filename: "../intruder/x.md",
        contentType: "text/markdown",
      }),
    ).rejects.toThrow(/path traversal/);
  });

  it("rejects filenames that start with `/`", async () => {
    const { deps } = makeDeps();
    const storage = createVaultStorage(deps);
    await expect(
      storage.signUpload({
        bucket: "noelle-vaults",
        prefix: "demooperator/",
        filename: "/etc/passwd",
        contentType: "text/markdown",
      }),
    ).rejects.toThrow(/path traversal/);
  });

  it("delete also enforces the safe-filename rule", async () => {
    const { deps } = makeDeps();
    const storage = createVaultStorage(deps);
    await expect(
      storage.delete({
        bucket: "noelle-vaults",
        prefix: "demooperator/",
        filename: "../etc/passwd",
      }),
    ).rejects.toThrow(/path traversal/);
  });

  it("writeText puts the body at the resolved object path", async () => {
    const deps = makeDeps();
    const storage = createVaultStorage(deps.deps);
    await storage.writeText({
      bucket: "noelle-vaults",
      prefix: "acme/",
      filename: "02-brand/voice.md",
      body: "# Voice\n",
    });
    const fakeBucket = deps.fakeBucket as unknown as {
      file: ReturnType<typeof vi.fn>;
    };
    expect(fakeBucket.file).toHaveBeenCalledWith("acme/02-brand/voice.md");
    const fileCallResult = fakeBucket.file.mock.results[0]?.value as {
      save: ReturnType<typeof vi.fn>;
    };
    expect(fileCallResult.save).toHaveBeenCalledWith(
      "# Voice\n",
      expect.objectContaining({ contentType: "text/markdown" }),
    );
  });

  it("writeText rejects path traversal in filename", async () => {
    const deps = makeDeps();
    const storage = createVaultStorage(deps.deps);
    await expect(
      storage.writeText({
        bucket: "noelle-vaults",
        prefix: "acme/",
        filename: "../intruder/x.md",
        body: "x",
      }),
    ).rejects.toThrow(/path traversal/);
  });

  it("rejects an unsafe prefix (no trailing slash)", async () => {
    const { deps } = makeDeps();
    const storage = createVaultStorage(deps);
    await expect(
      storage.readText({ bucket: "noelle-vaults", prefix: "demooperator", filename: "a.md" }),
    ).rejects.toThrow(/unsafe vault prefix/);
  });

  it("rejects an unsafe prefix (path traversal in prefix)", async () => {
    const { deps } = makeDeps();
    const storage = createVaultStorage(deps);
    await expect(
      storage.list({ bucket: "noelle-vaults", prefix: "a/../b/" }),
    ).rejects.toThrow(/unsafe vault prefix/);
  });
});

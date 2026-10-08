import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { managedFixture, fixtureName as name } from "./secretManager.fixture.js";
import { nativeManager, until } from "./secretProcess.fixture.js";
afterEach(() => vi.useRealTimers());
it("owns actual WIF exchange and impersonation for all six SDK operations", async () => {
  const server = await managedFixture(),
    create = await nativeManager();
  const client = create({ ...server.config, timeoutMs: 30000 });
  try {
    expect((await client.getSecret({ name }))[0].name).toBe(name);
    expect(
      (
        await client.accessSecretVersion({ name: `${name}/versions/latest` })
      )[0].payload.data.toString(),
    ).toBe("fixture-value");
    const [versions, , page] = await client.listSecretVersions({ parent: name, pageSize: 2 });
    expect(versions).toHaveLength(2);
    expect(versions[0]?.createTime?.seconds).toBe("1700000000");
    expect(versions[0]?.state).toBe("ENABLED");
    expect(page.nextPageToken).toBe("next");
    expect(
      (
        await client.createSecret({
          parent: "projects/fixture",
          secretId: "one",
          secret: { replication: { automatic: {} } },
        })
      )[0].name,
    ).toBe(name);
    expect(
      (await client.addSecretVersion({ parent: name, payload: { data: Buffer.from("saved") } }))[0]
        .name,
    ).toBe(`${name}/versions/3`);
    expect((await client.disableSecretVersion({ name: `${name}/versions/1` }))[0].name).toBe(
      `${name}/versions/1`,
    );
    expect(server.state).toMatchObject({
      rpc: 6,
      auth: 6,
      iam: 6,
      authenticated: true,
      writeBytes: 5,
    });
    await until(() => server.sockets.size === 0);
  } finally {
    await server.close();
  }
});
it.each(["STATE_UNSPECIFIED", "unrecognized"])(
  "rejects unresolved native version state%s",
  async (state) => {
    const server = await managedFixture(),
      create = await nativeManager();
    server.state.versionState = state;
    try {
      await expect(
        create(server.config).listSecretVersions({ parent: name, pageSize: 2 }),
      ).rejects.toMatchObject({ code: "invalid_response" });
      expect(server.state.disabled).toHaveLength(0);
    } finally {
      await server.close();
    }
  },
);
it.each(["sts", "iam"])(
  "closes a held native%s exchange before rejecting and recovers",
  async (hold) => {
    const server = await managedFixture(),
      create = await nativeManager();
    server.state.hold = hold;
    let pending: Promise<unknown> | undefined;
    try {
      vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
      const client = create({ ...server.config, timeoutMs: 30000 });
      pending = client.getSecret({ name }).catch((error) => error);
      await until(() => (hold === "sts" ? server.state.auth === 1 : server.state.iam === 1));
      await vi.advanceTimersByTimeAsync(30000);
      expect(await pending).toMatchObject({ code: "timeout" });
      await until(() => server.sockets.size === 0);
      await delay(80);
      expect(server.state.rpc).toBe(0);
      vi.useRealTimers();
      server.state.hold = "";
      expect((await create(server.config).getSecret({ name }))[0].name).toBe(name);
      expect(server.state.rpc).toBe(1);
    } finally {
      if (pending && vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(30000);
        await pending;
      }
      vi.useRealTimers();
      await server.close();
    }
  },
  15000,
);
it("retains explicit pages instead of SDK automatic pagination", async () => {
  const server = await managedFixture(),
    create = await nativeManager();
  try {
    const client = create(server.config);
    const [first, , page] = await client.listSecretVersions({ parent: name, pageSize: 2 });
    expect(first).toHaveLength(2);
    expect(server.state.rpc).toBe(1);
    const [second] = await client.listSecretVersions({
      parent: name,
      pageSize: 2,
      pageToken: page.nextPageToken,
    });
    expect(second).toHaveLength(1);
    expect(server.state.rpc).toBe(2);
  } finally {
    await server.close();
  }
});
it("reports an ambiguous native write without replay and closes its socket", async () => {
  const server = await managedFixture(),
    create = await nativeManager();
  server.state.hold = "write";
  let pending: Promise<unknown> | undefined;
  try {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    pending = create({ ...server.config, timeoutMs: 30000 })
      .addSecretVersion({ parent: name, payload: { data: Buffer.from("saved") } })
      .catch((error) => error);
    await until(() => server.state.adds === 1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await pending).toMatchObject({ code: "outcome_unknown" });
    await until(() => server.sockets.size === 0);
    await delay(100);
    expect(server.state.adds).toBe(1);
  } finally {
    if (pending && vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(30000);
      await pending;
    }
    vi.useRealTimers();
    await server.close();
  }
}, 15000);
it.each([65536, 65537])(
  "validates native write%s bytes before its acknowledgment",
  async (size) => {
    const server = await managedFixture(),
      create = await nativeManager();
    try {
      const pending = create(server.config).addSecretVersion({
        parent: name,
        payload: { data: Buffer.alloc(size) },
      });
      if (size === 65536) {
        expect((await pending)[0].name).toBe(`${name}/versions/3`);
        expect(server.state.writeBytes).toBe(size);
      } else {
        await expect(pending).rejects.toMatchObject({ code: "body_too_large" });
        expect(server.state.rpc).toBe(0);
      }
    } finally {
      await server.close();
    }
  },
);
it("keeps failed native write content private and does not retry", async () => {
  const server = await managedFixture(),
    create = await nativeManager();
  server.state.status = 500;
  try {
    await expect(
      create(server.config).addSecretVersion({
        parent: name,
        payload: { data: Buffer.from("saved") },
      }),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(server.state.adds).toBe(1);
    await delay(100);
    expect(server.state.adds).toBe(1);
  } finally {
    await server.close();
  }
});
it("rejects a nested version resource inside a paged receipt", async () => {
  const server = await managedFixture(),
    create = await nativeManager();
  server.state.versionPathSuffix = "/versions/1";
  try {
    await expect(
      create(server.config).listSecretVersions({ parent: name, pageSize: 2 }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  } finally {
    await server.close();
  }
});
it("rejects contradictory metadata without returning a receipt", async () => {
  const server = await managedFixture(),
    create = await nativeManager();
  server.state.coherent = false;
  try {
    await expect(create(server.config).getSecret({ name })).rejects.toMatchObject({
      code: "invalid_response",

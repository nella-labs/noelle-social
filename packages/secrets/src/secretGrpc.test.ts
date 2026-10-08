import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { grpcService } from "./secretGrpc.fixture.js";
import { nativeSecrets, options, serve, token, until } from "./secretProcess.fixture.js";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
it("validates authenticated native gRPC bytes and rejects failures without replay", async () => {
  const create = await nativeSecrets(),
    service = await grpcService();
  const oauth = await serve((_req, res) => token(res));
  vi.stubEnv("GRPC_DEFAULT_SSL_ROOTS_FILE_PATH", service.cert);
  const client = create({
    ...options(oauth),
    sdkOptions: { projectId: "fixture", apiEndpoint: "localhost", port: service.port },
  });
  try {
    expect(await client.get("healthy")).toHaveLength(65536);
    service.state.size = 65537;
    await expect(client.get("large")).rejects.toMatchObject({ code: "body_too_large" });
    service.state.size = 129 * 1024;
    await expect(client.get("wire-overflow")).rejects.toMatchObject({ code: "failed" });
    service.state.mode = "denied";
    await expect(client.getForOrg("org", "key")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    service.state.mode = "unavailable";
    await expect(client.get("unavailable")).rejects.toMatchObject({ code: "failed" });
    await delay(100);
    expect(service.state.hits).toBe(5);
    expect(service.state.authenticated).toBe(true);
  } finally {
    await service.close();
    await oauth.close();
  }
}, 15_000);
it("cancels a held native gRPC call before rejection and recovers", async () => {
  const create = await nativeSecrets(),
    service = await grpcService();
  const oauth = await serve((_req, res) => token(res));
  vi.stubEnv("GRPC_DEFAULT_SSL_ROOTS_FILE_PATH", service.cert);
  const client = create({
    ...options(oauth),
    sdkOptions: { projectId: "fixture", apiEndpoint: "localhost", port: service.port },
  });
  service.state.mode = "held";
  let pending: Promise<unknown> | undefined;
  try {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    pending = client.get("held").catch((error) => error);
    await until(() => service.state.hits === 1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ code: "timeout" });
    await until(() => service.state.cancelled === 1);
    await delay(100);
    expect(service.state.hits).toBe(1);
    vi.useRealTimers();
    service.state.mode = "healthy";
    expect(await client.get("held")).toHaveLength(65536);
    expect(service.state.hits).toBe(2);
  } finally {
    if (pending && vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
    }
    vi.useRealTimers();
    await service.close();
    await oauth.close();
  }
}, 15_000);

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  create: vi.fn(),
  manager: vi.fn(),
  access: vi.fn(),
  owners: [] as object[],
}));
vi.mock("@noelle/runtime", () => ({
  createBedrockBackend: fixture.create,
  BedrockProcess: class {
    constructor() { fixture.owners.push(this); }
  },
}));
vi.mock("@/lib/sm", () => ({ getSecretManagerClient: fixture.manager, SM_PROJECT: "fixture-project" }));
import { loadBedrockBackend } from "./bedrock-backend";

const globals = globalThis as unknown as Record<string, unknown>;
beforeEach(() => {
  vi.resetAllMocks();
  fixture.owners = [];
  delete globals.__noelleBedrockBackends;
  delete globals.__noelleAppBedrockProcess;
  vi.stubEnv("NOELLE_SECRETS_SOURCE", "env");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture-access-first");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture-secret-first");
  fixture.create.mockImplementation(() => ({ call: vi.fn() }));
  fixture.manager.mockResolvedValue({ accessSecretVersion: fixture.access });
  fixture.access.mockImplementation(async ({ name }: { name: string }) => [{
    payload: { data: Buffer.from(name.includes("aws-access-key-id") ? "fixture-access-first" : "fixture-secret-first") },
  }]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete globals.__noelleBedrockBackends;
  delete globals.__noelleAppBedrockProcess;
});

it("refreshes environment credentials for the next dashboard invocation", async () => {
  await loadBedrockBackend();
  vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture-access-next");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture-secret-next");
  await loadBedrockBackend();
  expect(fixture.create).toHaveBeenCalledTimes(2);
  expect(fixture.create.mock.calls[1]![0]).toMatchObject({
    accessKeyId: "fixture-access-next", secretAccessKey: "fixture-secret-next", maxTokens: 512,
  });
});
it("reads the current managed invocation before constructing each backend", async () => {
  vi.stubEnv("NOELLE_SECRETS_SOURCE", "managed");
  await loadBedrockBackend();
  await loadBedrockBackend();
  expect(fixture.manager).toHaveBeenCalledTimes(2);
  expect(fixture.access).toHaveBeenCalledTimes(4);
  expect(fixture.create).toHaveBeenCalledTimes(2);
});
it("does not bypass a revoked managed invocation after a successful call", async () => {
  vi.stubEnv("NOELLE_SECRETS_SOURCE", "managed");
  await loadBedrockBackend();
  fixture.manager.mockRejectedValueOnce(new Error("Invocation unavailable"));
  await expect(loadBedrockBackend()).rejects.toMatchObject({ stage: "secret_manager_client" });
  expect(fixture.create).toHaveBeenCalledTimes(1);
});
it("does not retain revoked environment credentials", async () => {
  await loadBedrockBackend();
  vi.stubEnv("AWS_ACCESS_KEY_ID", "");
  await expect(loadBedrockBackend()).rejects.toMatchObject({ stage: "secret_empty" });
  expect(fixture.create).toHaveBeenCalledTimes(1);
});
it("shares only the canonical process admission owner across token limits", async () => {
  for (let maxTokens = 1; maxTokens <= 40; maxTokens++) await loadBedrockBackend(maxTokens);
  expect(fixture.owners).toHaveLength(1);
  const owner = fixture.owners[0];
  for (const [options] of fixture.create.mock.calls) expect(options.processOwner).toBe(owner);
  expect(globals.__noelleBedrockBackends).toBeUndefined();
});
it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid token admission %s before credential work", async maxTokens => {
    vi.stubEnv("NOELLE_SECRETS_SOURCE", "managed");
    await expect(loadBedrockBackend(maxTokens)).rejects.toThrow("positive safe integer");
    expect(fixture.manager).not.toHaveBeenCalled();
    expect(fixture.access).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  },
);
it("awaits both started secret reads before reporting their failure", async () => {
  vi.stubEnv("NOELLE_SECRETS_SOURCE", "managed");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  fixture.access.mockImplementation(async ({ name }: { name: string }) => {
    if (name.includes("aws-access-key-id")) throw new Error("Access unavailable");
    await held;
    return [{ payload: { data: Buffer.from("fixture-secret-first") } }];
  });
  let finished = false;
  const pending = loadBedrockBackend().catch(error => error).finally(() => { finished = true; });
  try {
    await vi.waitFor(() => { expect(fixture.access).toHaveBeenCalledTimes(2); });
    await Promise.resolve();
    expect(finished).toBe(false);
  } finally { release(); }
  expect(await pending).toMatchObject({ stage: "secret_manager_fetch" });
  expect(fixture.create).not.toHaveBeenCalled();
});
it("preserves backend-construction errors after a valid credential read", async () => {
  fixture.create.mockImplementationOnce(() => { throw new Error("Unavailable backend"); });
  await expect(loadBedrockBackend()).rejects.toMatchObject({ stage: "backend_construct" });
});

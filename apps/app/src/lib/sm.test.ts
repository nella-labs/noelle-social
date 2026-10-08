import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  headers: vi.fn(),
  create: vi.fn(),
  check: vi.fn(),
  owners: [] as object[],
}));
vi.mock("next/headers", () => ({ headers: fixture.headers }));
vi.mock("@noelle/secrets", () => ({
  createSecretManagerClient: fixture.create,
  SecretAccessError: class extends Error {},
  SecretManagerProcess: class {
    constructor() {
      fixture.owners.push(this);
    }
    checkAvailable() {
      fixture.check();
    }
  },
}));
import { getSecretManagerClient } from "./sm";
const env = {
  NOELLE_GCP_PROJECT_NUMBER: "123",
  NOELLE_GCP_POOL_ID: "pool",
  NOELLE_GCP_PROVIDER_ID: "provider",
  NOELLE_GCP_SA_EMAIL: "fixture@example.com",
};
beforeEach(() => {
  vi.clearAllMocks();
  fixture.owners = [];
  delete globalThis.__noelleSmProcess;
  for (const key of Object.keys(env)) vi.stubEnv(key, "");
  fixture.headers.mockResolvedValue(new Headers({ "x-vercel-oidc-token": "first-subject" }));
  fixture.create.mockImplementation((options) => options);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  delete globalThis.__noelleSmProcess;
});
function managed() {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}
it("binds each invocation header without retaining global authentication", async () => {
  managed();
  await getSecretManagerClient();
  fixture.headers.mockResolvedValue(new Headers({ "x-vercel-oidc-token": "next-subject" }));
  await getSecretManagerClient();
  const [first, next] = fixture.create.mock.calls.map((call) => call[0]);
  expect(first.wif.subjectToken).toBe("first-subject");
  expect(next.wif.subjectToken).toBe("next-subject");
  expect(first.owner).toBe(next.owner);
  expect(fixture.owners).toHaveLength(1);
  expect(first.wif.audience).toContain("/projects/123/");
  expect(first.wif.serviceAccountImpersonationUrl).toContain(
    "/fixture@example.com:generateAccessToken",
  );
});
it("preserves local ADC without reading a request header", async () => {
  await getSecretManagerClient();
  expect(fixture.headers).not.toHaveBeenCalled();
  expect(fixture.create.mock.calls[0]![0].wif).toBeUndefined();
});
it("rejects partial managed configuration before credential dispatch", async () => {
  vi.stubEnv("NOELLE_GCP_POOL_ID", "pool");
  await expect(getSecretManagerClient()).rejects.toThrow("Incomplete");
  expect(fixture.create).not.toHaveBeenCalled();
});
it("requires the managed invocation header without falling through to ADC", async () => {
  managed();
  fixture.headers.mockResolvedValue(new Headers());
  await expect(getSecretManagerClient()).rejects.toThrow("identity is missing");
  expect(fixture.create).not.toHaveBeenCalled();
});
it("refuses full admission before reading or retaining another header", async () => {
  managed();
  fixture.check.mockImplementationOnce(() => {
    throw new Error("busy");
  });
  await expect(getSecretManagerClient()).rejects.toThrow("busy");
  expect(fixture.headers).not.toHaveBeenCalled();
  expect(fixture.create).not.toHaveBeenCalled();
});
it("starts the sequence clock before resolving the invocation header", async () => {
  managed();
  vi.useFakeTimers({ toFake: ["performance"] });
  const started = performance.now();
  fixture.headers.mockImplementationOnce(async () => {
    await vi.advanceTimersByTimeAsync(1000);
    return new Headers({ "x-vercel-oidc-token": "fixture" });
  });
  await getSecretManagerClient();
  expect(fixture.create.mock.calls[0]![0].deadline).toBe(started + 8000);
});

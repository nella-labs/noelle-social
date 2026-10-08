import { afterEach, expect, it, vi } from "vitest";
const run = vi.hoisted(() => vi.fn());
vi.mock("./cliProcess.js", async (original) => ({
  ...(await original<typeof import("./cliProcess.js")>()),
  runCliProcess: run,
}));
import { BedrockProcess } from "./bedrockProcess.js";
afterEach(() => {
  vi.useRealTimers();
  run.mockReset();
});
const request = {
  region: "us-east-1",
  body: {
    model: "fixture",
    max_tokens: 1,
    messages: [{ role: "user" as const, content: "Fixture" }],
  },
};
const receipt = {
  code: 0,
  stdout: JSON.stringify({ ok: true, value: { content: [], usage: {} } }),
};
it("rejects a process result past admission deadline before an overdue timer can run", async () => {
  vi.useFakeTimers({ toFake: ["performance"] });
  let finish!: (value: typeof receipt) => void;
  run.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = new BedrockProcess()
    .request(request, performance.now() + 20)
    .catch((error) => error);
  await vi.advanceTimersByTimeAsync(30);
  finish(receipt);
  expect(await pending).toMatchObject({ code: "timeout" });
  expect(run).toHaveBeenCalledTimes(1);
});
it("accepts an on-time closed process receipt", async () => {
  run.mockResolvedValue(receipt);
  expect(await new BedrockProcess().request(request, performance.now() + 1000)).toEqual({
    content: [],
    usage: {},
  });
});
it("rejects a full queue before serializing another request", async () => {
  let finish!: (value: typeof receipt) => void;
  const held = new Promise((resolve) => {
    finish = resolve;
  });
  run.mockReturnValue(held);
  const owner = new BedrockProcess();
  const pending = Array.from({ length: 32 }, () =>
    owner.request(request, performance.now() + 5000),
  );
  const serialize = vi.fn(() => {
    throw new Error("must not serialize");
  });
  try {
    await expect(
      owner.request(
        { ...request, body: Object.assign({}, request.body, { toJSON: serialize }) },
        performance.now() + 5000,
      ),
    ).rejects.toMatchObject({ code: "busy" });
    expect(serialize).not.toHaveBeenCalled();
  } finally {
    finish(receipt);
    await Promise.all(pending);
  }
});

import { describe, expect, it, vi, beforeEach } from "vitest";

const runMock = vi.fn(
  async (_cmd: string, _args: string[], _opts?: unknown) => ({ code: 0, stdout: "", stderr: "" }),
);
vi.mock("./platform.js", () => ({ run: runMock }));

const { pm2DeployRestartTargets, pm2RestartMany, pm2Status, pm2RestartFromEcosystem, pm2Stop } = await import("./process-manager.js");

describe("process manager failure boundaries", () => {
  beforeEach(() => runMock.mockReset());
  it("does not describe a failed status query as an intentionally empty fleet", async () => {
    runMock.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "unavailable" });
    await expect(pm2Status("/fixture-repo")).rejects.toThrow(/status/i);
  });
  it.each(["not json", "{}", "[null]"])("rejects an invalid fleet receipt %s", async (stdout) => {
    runMock.mockResolvedValueOnce({ code: 0, stdout, stderr: "" });
    await expect(pm2Status("/fixture-repo")).rejects.toThrow(/status/i);
  });
  it("preserves a successful empty fleet and valid process state", async () => {
    runMock.mockResolvedValueOnce({ code: 0, stdout: "[]", stderr: "" });
    expect(await pm2Status("/fixture-repo")).toEqual([]);
    runMock.mockResolvedValueOnce({ code: 0, stdout: '[{"name":"noelle-app","pm2_env":{"status":"online"}}]', stderr: "" });
    expect(await pm2Status("/fixture-repo")).toMatchObject([{ name: "noelle-app", status: "online" }]);
  });
  it("requires a successful named restart before claiming a fresh environment", async () => {
    runMock.mockImplementationOnce(async (_cmd, _args, opts) => {
      if (!(opts as { allowFailure?: boolean }).allowFailure) throw new Error("restart failed");
      return { code: 1, stdout: "", stderr: "restart failed" };
    });
    await expect(pm2RestartFromEcosystem("/fixture-repo", "/fixture.cjs", "noelle-app"))
      .rejects.toThrow("restart failed");
  });
});

describe("pm2RestartMany", () => {
  beforeEach(() => runMock.mockClear());

  it("restarts through the ecosystem file so a refreshed .env reaches the fleet", async () => {
    // `pm2 restart <name> --update-env` refreshes from the DAEMON's environment,
    // not from .env — the flag name is a trap. A deploy reported "27 apps
    // restarted, smoke ok" while every worker kept the env it booted with, so a
    // newly added NOELLE_CODEX_CLI=1 did nothing at all.
    await pm2RestartMany("/repo", ["a", "b"], "/home/.noelle/ecosystem.config.cjs");
    const args = runMock.mock.calls[0]![1];
    expect(args).toContain("/home/.noelle/ecosystem.config.cjs");
    expect(args[args.indexOf("--only") + 1]).toBe("a,b");
    expect(args).toContain("--update-env");
  });

  it("covers the whole fleet in ONE invocation", async () => {
    await pm2RestartMany("/repo", ["a", "b", "c"], "/eco.cjs");
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the name form when no ecosystem path is known", async () => {
    // Pre-init, there is no ecosystem file yet. Restarting by name still
    // restarts; it just cannot pick up new env.
    await pm2RestartMany("/repo", ["a"], undefined);
    const args = runMock.mock.calls[0]![1];
    expect(args).not.toContain("--only");
    expect(args).toContain("a");
  });

  it("does nothing for an empty fleet", async () => {
    expect(await pm2RestartMany("/repo", [], "/eco.cjs")).toBeNull();
    expect(runMock).not.toHaveBeenCalled();
  });
});

describe("pm2DeployRestartTargets", () => {
  it("leaves intentionally stopped apps out of deploy restarts", () => {
    const targets = pm2DeployRestartTargets([
      { name: "noelle-app", status: "online", cwd: "/repo", restarts: 2, cpu: 1, memoryMb: 80 },
      { name: "noelle-send", status: "stopped", cwd: "/repo", restarts: 0, cpu: 0, memoryMb: 0 },
      { name: "noelle-drafter", status: "online", cwd: "/repo", restarts: 3, cpu: 2, memoryMb: 140 },
    ], "/repo");

    expect(targets).toEqual(["noelle-app", "noelle-drafter"]);
  });

  it("keeps errored apps in deploy restarts so a normal deploy can recover them", () => {
    const targets = pm2DeployRestartTargets([
      { name: "noelle-app", status: "online", cwd: "/repo", restarts: 2, cpu: 1, memoryMb: 80 },
      { name: "noelle-reddit-drafter", status: "errored", cwd: "/repo", restarts: 17, cpu: 0, memoryMb: 0 },
      { name: "noelle-send", status: "stopped", cwd: "/repo", restarts: 0, cpu: 0, memoryMb: 0 },
    ], "/repo");

    expect(targets).toEqual(["noelle-app", "noelle-reddit-drafter"]);
  });
});


describe("managed fleet isolation", () => {
  beforeEach(() => runMock.mockReset());
  const process = (name: string, cwd = "/repo", status = "online") => ({ name, cwd, status, restarts: 0, cpu: 0, memoryMb: 0 });
  it("deploys only registered services from this checkout", () => {
    expect(pm2DeployRestartTargets([
      process("other-project"), process("noelle-not-a-service"),
      process("noelle-app", "/other-repo"), process("chrome-bridge", "/repo/apps/chrome-bridge"),
      process("actuator-doctor", "/repo/apps/actuator-doctor"), process("noelle-drafter"),
      process("noelle-send", "/repo", "stopped"),
    ], "/repo")).toEqual(["chrome-bridge", "actuator-doctor", "noelle-drafter"]);
  });
  it("deletes only owned services after a successful inventory receipt", async () => {
    runMock.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify([
      { name: "other-project", pm2_env: { pm_cwd: "/repo", status: "online" } },
      { name: "noelle-app", pm2_env: { pm_cwd: "/repo", status: "online" } },
      { name: "noelle-drafter", pm2_env: { pm_cwd: "/other-repo", status: "online" } },
    ]), stderr: "" });
    runMock.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    await pm2Stop("/repo", true);
    expect(runMock.mock.calls.map((call) => call[1].slice(4))).toEqual([["jlist"], ["delete", "noelle-app"]]);
    expect((runMock.mock.calls[1]![2] as { allowFailure: boolean }).allowFailure).toBe(false);
  });
  it("never deletes a fleet when inventory fails", async () => {
    runMock.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "unavailable" });
    await expect(pm2Stop("/repo", true)).rejects.toThrow();
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0]![1]).toContain("jlist");
  });
  it("does nothing when this checkout owns no processes", async () => {
    runMock.mockResolvedValueOnce({ code: 0, stdout: "[]", stderr: "" });
    await pm2Stop("/repo", false);
    expect(runMock).toHaveBeenCalledTimes(1);
  });
});

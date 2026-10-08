import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig, paths } from "../config.js";
import { generateEcosystem } from "./process-manager.js";
import { BACKEND_BUILD_PACKAGES, MANAGED_PROCESS_NAMES } from "./service-manifest.js";
const execute = vi.hoisted(() => vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }));
vi.mock("./platform.js", () => ({ run: execute }));
import { buildBackendServices } from "./backend-build.js";

describe("ecosystem build ownership", () => {
  it.each([false, true])("builds every enabled compiled service before startup (workers=%s)", async (workersEnabled) => {
    execute.mockClear();
    const config = { ...defaultConfig(), workersEnabled };
    const module = { exports: {} as { apps: Array<{ name: string; cwd: string; autostart?: boolean }> } };
    runInNewContext(generateEcosystem({ config, repoRoot: "/fixture", paths: paths() }), {
      module, require: () => ({ existsSync: () => false }),
    });
    await buildBackendServices({ repoRoot: "/fixture", workersEnabled, env: {} });
    const args = execute.mock.calls[0]![1] as string[];
    const packages = args.filter((_, index) => args[index - 1] === "--filter");
    expect(MANAGED_PROCESS_NAMES).toEqual(new Set(module.exports.apps.map((app) => app.name)));
    for (const app of module.exports.apps.filter((app) => app.autostart !== false && app.name !== "noelle-app")) {
      const packageName = app.cwd.startsWith("/fixture/apps/") ? `@noelle/${app.cwd.slice("/fixture/apps/".length)}`
        : app.name === "noelle-api-vm" ? "@noelle/api-vm" : "@noelle/cli";
      expect(packages, app.name).toContain(packageName);
    }
    expect(packages).toEqual(workersEnabled ? BACKEND_BUILD_PACKAGES : BACKEND_BUILD_PACKAGES.slice(0, 4));
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

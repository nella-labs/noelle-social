import { BACKEND_BUILD_PACKAGES } from "./service-manifest.js";
import { run } from "./platform.js";

/** Build every compiled entry the selected ecosystem can start. */
export async function buildBackendServices(args: {
  repoRoot: string; workersEnabled: boolean; env: NodeJS.ProcessEnv;
}): Promise<void> {
  const packages = args.workersEnabled ? BACKEND_BUILD_PACKAGES : BACKEND_BUILD_PACKAGES.slice(0, 4);
  await run("pnpm", ["-r", ...packages.flatMap((name) => ["--filter", name]), "build"], {
    cwd: args.repoRoot, env: args.env, inherit: true, timeoutMs: 20 * 60_000,
  });
}

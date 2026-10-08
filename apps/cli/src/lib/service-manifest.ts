/** Process names and worker directories shared by build and lifecycle control. */
export const SERVICES = {
  api: "noelle-api-vm", app: "noelle-app", spend: "noelle-spend-rollup",
  bridge: "chrome-bridge", doctor: "actuator-doctor",
} as const;

const groups = [
  { prefix: "noelle-", app: "x-intern", kinds: ["discovery", "classifier", "drafter", "profiler", "send", "ideation", "account-feeder"] },
  { prefix: "noelle-linkedin-", app: "linkedin-intern", kinds: ["discovery", "classifier", "profiler", "drafter", "ideation", "post-drafter", "feeder"] },
  { prefix: "noelle-reddit-", app: "reddit-intern", kinds: ["discovery", "classifier", "drafter"] },
  { prefix: "noelle-video-", app: "video-intern", kinds: ["harvester", "teardown", "distiller", "ideator", "scripter"] },
] as const;

export const WORKER_SERVICES = groups.flatMap((group) => group.kinds.map((kind) => ({
  name: group.prefix + kind, app: group.app, kind, autonomous: kind !== "send",
})));

export const MANAGED_PROCESS_NAMES = new Set<string>([
  ...Object.values(SERVICES), ...WORKER_SERVICES.map((worker) => worker.name),
]);

/** Every compiled backend entry referenced by the generated ecosystem. */
export const BACKEND_BUILD_PACKAGES = [
  "@noelle/api-vm", "@noelle/cli", "@noelle/chrome-bridge", "@noelle/actuator-doctor",
  ...groups.map((group) => `@noelle/${group.app}`),
];

export function parseReconcileOptions(argv: string[]): { orgId: string; apply: boolean } {
  let orgId: string | undefined;
  let apply = false;
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--apply") {
      apply = true;
      continue;
    }
    if (option === "--org-id") {
      orgId = argv[++index];
      continue;
    }
    throw new Error(`unknown option: ${option ?? ""}`);
  }
  if (!orgId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
    throw new Error("--org-id must be a UUID");
  }
  return { orgId, apply };
}

export { resolveXReplyMaxAgeHours } from "@noelle/contracts";

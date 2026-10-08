import { isRelationshipDmEnabled } from "@noelle/contracts";
import {
  hasPendingRelationshipDmRequests as defaultHasPendingRelationshipDmRequests,
  runRelationshipDmTick as defaultRunRelationshipDmTick,
  type RelationshipDmTickArgs,
} from "@noelle/runtime/relationship-dm";
import type { ActiveInstance } from "./activation.js";
import { xInternRouting } from "./routing.js";

type RelationshipDmInstance = Pick<
  ActiveInstance,
  "id" | "org_id" | "status" | "lane_config" | "model_overrides"
>;

type RunRelationshipDmsArgs = Pick<
  RelationshipDmTickArgs,
  "sql" | "runner" | "postOutbound" | "log"
> & {
  instance: ActiveInstance;
  runRelationshipDmTick?: (args: RelationshipDmTickArgs) => Promise<number>;
  hasPendingRelationshipDmRequests?: typeof defaultHasPendingRelationshipDmRequests;
};

export function isRelationshipDmsLaneEnabled(inst: RelationshipDmInstance): boolean {
  return isRelationshipDmEnabled(inst.status, inst.lane_config);
}

export async function runRelationshipDmsForInstance(args: RunRelationshipDmsArgs): Promise<number> {
  const includeRecurring = isRelationshipDmsLaneEnabled(args.instance);
  if (!includeRecurring) {
    const hasPending = args.hasPendingRelationshipDmRequests ?? defaultHasPendingRelationshipDmRequests;
    const pending = await hasPending(args.sql, {
      orgId: args.instance.org_id,
      instanceId: args.instance.id,
      platform: "x",
    });
    if (!pending) return 0;
  }
  const runTick = args.runRelationshipDmTick ?? defaultRunRelationshipDmTick;
  return runTick({
    sql: args.sql,
    orgId: args.instance.org_id,
    instanceId: args.instance.id,
    platform: "x",
    includeRecurring,
    runner: args.runner,
    routing: xInternRouting(args.instance),
    postOutbound: args.postOutbound,
    log: args.log,
  });
}

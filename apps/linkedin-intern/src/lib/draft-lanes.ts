import type { LeadRow } from "./leads-db.js";

/** Keep browser-qualified leads out of the unverified light-batch path. */
export function planDraftLanes(args: {
  observed: LeadRow[];
  priority: LeadRow[];
  keyword: LeadRow[];
}): Array<{ leads: LeadRow[]; forceVerify: boolean }> {
  const lanes: Array<{ leads: LeadRow[]; forceVerify: boolean }> = [];
  const claimedLater = [...args.priority, ...args.keyword];
  const browserSpill = claimedLater.filter((lead) => lead.payload.source === "extension_observed");
  const observed = [...args.observed, ...browserSpill];
  if (observed.length > 0) lanes.push({ leads: observed, forceVerify: true });
  lanes.push({
    leads: claimedLater.filter((lead) => lead.payload.source !== "extension_observed"),
    forceVerify: false,
  });
  return lanes;
}

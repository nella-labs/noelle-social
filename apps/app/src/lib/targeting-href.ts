/**
 * Build the href for the "Edit targeting →" button on the agent detail page.
 *
 * The button must only link to the targeting editor when there is a *real*
 * provisioned instance — the editor route (`…/agents/[instanceId]/watchlist`)
 * resolves the instance by UUID and 404s on a roster slug. Passing the URL
 * slug (e.g. `x-intern`) instead of the instance UUID produced a dead link;
 * always derive the href from the resolved instance id.
 *
 * Returns `undefined` when there is no real instance or the agent is not an
 * X intern, in which case the caller renders no link.
 */
export function targetingEditorHref(args: {
  orgSlug: string;
  isXIntern: boolean;
  instanceId: string | null | undefined;
}): string | undefined {
  if (!args.isXIntern || !args.instanceId) return undefined;
  return `/app/${args.orgSlug}/agents/${args.instanceId}/watchlist`;
}

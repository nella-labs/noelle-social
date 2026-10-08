/**
 * The guided setup step registry.
 *
 * Adding a step is appending one object to `GUIDED_STEPS`. Nothing else in the
 * app enumerates steps, so a new agent or a new prerequisite never means editing
 * copy in three components.
 *
 * Two rules keep this list honest:
 *
 *  1. A step is something the OPERATOR DOES. "Wait for the first draft" is not a
 *     step — it is the `waitingOn` reason attached to `approve`.
 *  2. A step is `required` only if the flow is genuinely broken without it. Voice
 *     grounding is fail-open (the drafter degrades to model priors when the vault
 *     is empty), so it is `recommended`, not `required` — which is precisely the
 *     bug in the flow this replaces.
 *
 * Pure: safe to import from a client component.
 */

import { isSocialAgentRole } from "@noelle/contracts";
import { agentHref } from "@/lib/agent-route";
import { INTERN_ROLES, type GuidedSignals, type GuidedStep, type InternRole } from "./types";

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

const isIntern = isSocialAgentRole;

/** Historical pending rows need setup before channel controls can run. */
const WAITLIST_STATUS = "provisioning_alpha";

function byRegistryOrder(a: { role: InternRole }, b: { role: InternRole }) {
  const order = new Map(INTERN_ROLES.map((r, i) => [r, i]));
  return (order.get(a.role) ?? 99) - (order.get(b.role) ?? 99);
}

/** Interns that really exist, in registry order (X first) so deep links are stable. */
export function hiredInterns(s: GuidedSignals) {
  return s.agents
    .filter((a) => isIntern(a.role) && a.status !== WAITLIST_STATUS)
    .slice()
    .sort(byRegistryOrder);
}

/** Interns the operator is queued for but does not have. */
export function waitlistedInterns(s: GuidedSignals) {
  return s.agents
    .filter((a) => isIntern(a.role) && a.status === WAITLIST_STATUS)
    .slice()
    .sort(byRegistryOrder);
}

/** The intern the guided flow deep-links into. */
export function primaryIntern(s: GuidedSignals) {
  const hired = hiredInterns(s);
  return hired.find(a => a.hasTargeting && a.status === "active")
    ?? hired.find(a => a.hasTargeting)
    ?? hired.find(a => a.status === "active")
    ?? hired[0] ?? null;
}

/** The X intern, only if it is a real hire. A waitlisted Vega cannot post. */
export function xIntern(s: GuidedSignals) {
  return hiredInterns(s).find((a) => a.role === "x_intern") ?? null;
}

function agentPath(orgSlug: string, s: GuidedSignals, suffix = ""): string {
  const intern = primaryIntern(s);
  if (!intern) return `/app/${orgSlug}/settings?tab=channels`;
  return suffix === "/watchlist" ? `/app/${orgSlug}/agents/${intern.instanceId}/watchlist` : agentHref(orgSlug, { display_name: intern.displayName, id: intern.instanceId }) + suffix;
}

/** Targeting route differs per agent; the watchlist subpage is shared. */
const TARGETING_NOUN: Record<InternRole, string> = {
  x_intern: "handles and keywords",
  linkedin_intern: "connections and keywords",
  reddit_intern: "subreddits",
  video_intern: "creators and niches",
};

export function targetingNoun(s: GuidedSignals): string {
  const intern = primaryIntern(s);
  return intern ? TARGETING_NOUN[intern.role] : "targets";
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const GUIDED_STEPS: readonly GuidedStep[] = [
  {
    id: "voice",
    tier: "recommended",
    eyebrow: "voice",
    title: "Teach your agents how you sound",
    blurb:
      "Answer a few questions, or import a folder of markdown you already write in. " +
      "Drafts still generate without this — they just sound like nobody in particular.",
    cta: "Open the voice wizard",
    href: (orgSlug, s) => `/app/${orgSlug}/onboarding/vault${s.vaultStage ? "?step=light" : ""}`,
    isComplete: (s) => s.vaultStage !== null,
  },
  {
    id: "data-source",
    tier: "required",
    eyebrow: "data source",
    title: "Add an Apify token",
    blurb:
      "Discovery reads through Apify. A pasted token starts out parked, so mark one as " +
      "in use or the workers never see it. Free tokens cap at $5 a month, so stack a few.",
    cta: "Open Connections",
    href: (orgSlug) => `/app/${orgSlug}/connections`,
    isComplete: (s) => s.hasApifyToken,
    // Workers fall back to a shared env/SM token when the in-use pool is empty,
    // so leads can arrive while this step is still open. Saying "add a token"
    // to someone whose queue is filling reads as a bug in us, not advice.
    note: (s) =>
      s.discoveredAny
        ? "Leads are arriving on the shared fallback token, which is capped. Promote one of your own."
        : null,
  },
  {
    id: "hire",
    tier: "required",
    eyebrow: "channels",
    title: "Set up your first channel",
    blurb:
      "Choose X, LinkedIn, Reddit, or short video. New channels start paused with sending off.",
    cta: "Open channel settings",
    href: (orgSlug) => `/app/${orgSlug}/settings?tab=channels`,
    isComplete: (s) => hiredInterns(s).length > 0,
    note: (s) => {
      const queued = waitlistedInterns(s);
      if (queued.length === 0) return null;
      const names = queued.map((a) => a.displayName ?? a.role).join(", ");
      return `${names} needs setup. Open channel settings to continue.`;
    },
  },
  {
    id: "targeting",
    tier: "required",
    eyebrow: "targeting",
    title: "Aim it at someone",
    blurb:
      "An intern with an empty watchlist discovers nothing, no matter how long you wait. " +
      "This is the step people skip and then wonder why the inbox is empty.",
    cta: "Edit the watchlist",
    href: (orgSlug, s) => agentPath(orgSlug, s, "/watchlist"),
    isComplete: (s) => Boolean(primaryIntern(s)?.hasTargeting),
    blockedBy: (s) => (hiredInterns(s).length === 0 ? "Set up a channel first." : null),
  },
  {
    id: "activate",
    tier: "required",
    eyebrow: "activate",
    title: "Enable discovery",
    blurb:
      "Enable topic discovery when your targets are ready. Paused X and LinkedIn channels may still follow their saved watchlists; sending remains a separate control.",
    cta: "Open the channel",
    href: (orgSlug, s) => agentPath(orgSlug, s),
    isComplete: (s) => primaryIntern(s)?.status === "active",
    blockedBy: (s) => (hiredInterns(s).length === 0 ? "Set up a channel first." : null),
  },
  {
    id: "approve",
    tier: "required",
    eyebrow: "approve",
    title: "Approve your first draft",
    blurb:
      "Read the draft, edit it if you want, then " +
      "approve it or mark it sent after posting by hand.",
    cta: "Open Engage",
    href: (orgSlug) => `/app/${orgSlug}/approvals`,
    isComplete: (s) => s.actionedAny,
    blockedBy: (s) => (hiredInterns(s).length === 0 ? "Set up a channel first." : null),
    waitingOn: (s) => {
      if (s.pendingApprovals > 0 || s.draftedAny) return null;
      const intern = primaryIntern(s);
      const running = intern?.status === "active" && intern.hasTargeting;
      if (!running) return null;
      return "Your intern is discovering. The first drafts usually land within a poll cycle.";
    },
  },
  {
    id: "publishing",
    tier: "advanced",
    eyebrow: "publishing",
    title: "Let Vega post for you",
    blurb:
      "Optional, and the only switch that makes Noelle write to a live account. Connect " +
      "X, then flip reply sending on. Read the account-safety notes first — velocity is " +
      "what gets accounts locked, not volume.",
    cta: "Connect X",
    href: (orgSlug) => `/app/${orgSlug}/connections`,
    isComplete: (s) => {
      const vega = xIntern(s);
      return Boolean(vega?.replySendEnabled) && s.xPostingReady;
    },
    blockedBy: (s) => (xIntern(s) ? null : "Hire Vega, the X intern, first."),

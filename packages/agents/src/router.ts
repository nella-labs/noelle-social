import { z } from "zod";
import type {
  AgentManifest,
  AgentRole,
  CapabilitySurface,
  CapabilityTag,
} from "./types.js";
import { CAPABILITY_TAGS } from "./types.js";

/**
 * Skill-to-agent capability router (see docs/agent-model.md § "Capability
 * routing" and the design spec). Two tiers:
 *
 *   1. `routeByCapability` — PURE, deterministic set-intersection over the
 *      manifests' `capability` facet. No LLM, no DB, no `orgId`. This is the
 *      whole substrate; it ships dark (no manifest need declare a capability).
 *   2. `routeByIntent` — the optional LLM disambiguation tier. Given free text,
 *      it asks a cheap model to pick ONE declared capability, then re-enters
 *      `routeByCapability`. It is FAIL-CLOSED: any model/parse failure, or a
 *      model answer that isn't an offered capability, yields `{kind:"none"}`.
 *      It can NEVER return a role no manifest declared.
 *
 * The router is deliberately ORG-AGNOSTIC: it takes no `orgId` and reads no DB,
 * so it cannot leak across tenants. Tenancy (assertOrgMember) + resolving a
 * decision to a hired/active instance happen in the CONSUMER, after routing.
 * The router only ever returns an existing {@link AgentRole}; it never mints one.
 */

/** A fully-resolved routing key. The deterministic tier needs a concrete tag. */
export type RouteIntent = {
  capability: CapabilityTag;
  surface: CapabilitySurface;
  /** Optional free text; carried for logging. Ignored by `routeByCapability`. */
  text?: string;
};

/**
 * A free-text intent for the LLM tier. `capability` may be unknown and inferred
 * from `text`; when it is present the LLM tier short-circuits to the pure tier.
 */
export type RouteQuery = {
  capability?: CapabilityTag;
  surface: CapabilitySurface;
  text?: string;
};

export type RouteMatch = {
  kind: "match";
  role: AgentRole;
  /** How the decision was reached. `capability` = deterministic; `llm` = tier 2. */
  via: "capability" | "llm";
  /** Other roles that also handle this (capability, surface), best-first. */
  alternatives: AgentRole[];
};

export type RouteNone = {
  kind: "none";
  reason: string;
};

export type RouteDecision = RouteMatch | RouteNone;

/** Accept either a registry map (`registry.manifests`) or a plain array. */
type ManifestSource =
  | ReadonlyMap<AgentRole, AgentManifest>
  | ReadonlyArray<AgentManifest>;

function toManifestArray(source: ManifestSource): ReadonlyArray<AgentManifest> {
  if (Array.isArray(source)) return source;
  return [...source.values()];
}

/** priority desc, then id asc — total + deterministic (guaranteed by the loader's
 * ambiguity guard, which forbids two roles sharing a (tag, surface, priority)). */
function compareByPriorityThenId(a: AgentManifest, b: AgentManifest): number {
  const pa = a.capability?.priority ?? 0;
  const pb = b.capability?.priority ?? 0;
  if (pb !== pa) return pb - pa;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * PURE deterministic tier. Filter manifests whose `capability` handles the tag
 * AND is invokable on the surface; order by priority desc, id asc; the head is
 * the match and the tail are ordered `alternatives`. Empty ⇒ `{kind:"none"}`.
 * Never guesses.
 */
export function routeByCapability(
  intent: RouteIntent,
  manifests: ManifestSource,
): RouteDecision {
  const ordered = toManifestArray(manifests)
    .filter((m) => {
      const cap = m.capability;
      return (
        cap !== undefined &&
        cap.handles.includes(intent.capability) &&
        cap.surfaces.includes(intent.surface)
      );
    })
    .sort(compareByPriorityThenId);

  const winner = ordered[0];
  if (winner === undefined) {
    return {
      kind: "none",
      reason: `no role handles "${intent.capability}" on surface "${intent.surface}"`,
    };
  }
  return {
    kind: "match",
    role: winner.id,
    via: "capability",
    alternatives: ordered.slice(1).map((m) => m.id),
  };
}

// ---------------------------------------------------------------------------
// LLM disambiguation tier (Phase 2). Promoted from the fail-open, pure-parse
// pattern in apps/app/src/lib/nova/plan-lanes.ts. The package makes NO model
// call of its own — the consumer injects `deps.call` (apps/app wires the shared
// Bedrock backend). Tests stub it and never hit the network.
// ---------------------------------------------------------------------------

/** Injected model call. Same shape apps/app's plan-lanes uses for Haiku. */
export type RouterModelCall = (args: {
  system: string;
  prompt: string;
  model: string;
}) => Promise<{ text: string }>;

export interface RouteByIntentDeps {
  /** REQUIRED. The consumer owns model routing + budget; the package stays pure. */
  call: RouterModelCall;
  /** Override the disambiguation model. Defaults to Haiku (cheap, fail-open). */
  model?: string;
}

const ROUTER_MODEL = "claude-haiku-4-5";

/**
 * LLM tier. Fast-path: a concrete `capability` short-circuits the model. Else
 * classify `text` into ONE offered capability via `deps.call`, then re-enter the
 * deterministic tier. FAIL-CLOSED at every step to `routeByCapability` or
 * `{kind:"none"}` — it never returns a role that no manifest declared.
 */
export async function routeByIntent(
  intent: RouteQuery,
  manifests: ManifestSource,
  deps: RouteByIntentDeps,
): Promise<RouteDecision> {
  // Fast path — a concrete capability needs no model.
  if (intent.capability !== undefined) {
    const key: RouteIntent =
      intent.text !== undefined
        ? { capability: intent.capability, surface: intent.surface, text: intent.text }
        : { capability: intent.capability, surface: intent.surface };
    return routeByCapability(key, manifests);
  }

  const list = toManifestArray(manifests);
  const candidateTags = collectCandidateTags(list, intent.surface);
  const text = (intent.text ?? "").trim();
  if (candidateTags.length === 0 || text === "") {
    return {
      kind: "none",
      reason:
        text === ""
          ? "empty intent text"
          : `no routable capabilities on surface "${intent.surface}"`,
    };
  }

  let chosen: CapabilityTag | null = null;
  try {
    const { system, prompt } = buildIntentClassifierMessages(
      text,
      intent.surface,
      candidateTags,
      list,
    );
    const res = await deps.call({ system, prompt, model: deps.model ?? ROUTER_MODEL });
    chosen = parseChosenCapability(res.text, candidateTags);
  } catch {
    chosen = null; // fail-closed
  }

  if (chosen === null) {
    // No usable classification ⇒ never fabricate a role.
    return { kind: "none", reason: "could not classify intent to a declared capability" };
  }

  // Re-enter the deterministic tier; a candidate tag always has ≥1 handler here.
  const decision = routeByCapability({ capability: chosen, surface: intent.surface, text }, list);
  return decision.kind === "match" ? { ...decision, via: "llm" } : decision;
}

/** Distinct tags handled by ≥1 manifest on `surface`, in stable vocabulary order. */
function collectCandidateTags(
  list: ReadonlyArray<AgentManifest>,
  surface: CapabilitySurface,
): CapabilityTag[] {
  const tags = new Set<CapabilityTag>();
  for (const m of list) {
    const cap = m.capability;
    if (cap === undefined || !cap.surfaces.includes(surface)) continue;
    for (const t of cap.handles) tags.add(t);
  }
  return CAPABILITY_TAGS.filter((t) => tags.has(t));
}

function buildIntentClassifierMessages(
  text: string,
  surface: CapabilitySurface,
  candidateTags: ReadonlyArray<CapabilityTag>,
  list: ReadonlyArray<AgentManifest>,
): { system: string; prompt: string } {
  const examplesByTag = new Map<CapabilityTag, string[]>();
  for (const m of list) {
    const cap = m.capability;
    if (cap === undefined || !cap.surfaces.includes(surface)) continue;
    const examples = cap.intent_examples ?? [];
    for (const t of cap.handles) {
      if (!candidateTags.includes(t)) continue;
      const arr = examplesByTag.get(t) ?? [];
      for (const e of examples) if (!arr.includes(e)) arr.push(e);
      examplesByTag.set(t, arr);
    }
  }
  const lines = candidateTags.map((t) => {
    const sample = (examplesByTag.get(t) ?? [])
      .slice(0, 4)
      .map((e) => `"${e}"`)
      .join("; ");
    return sample ? `- ${t} — e.g. ${sample}` : `- ${t}`;
  });
  const system = [
    "You are an intent router for an AI-agent org. Map the user's request to exactly ONE capability tag from the provided list, or to \"none\" if none fit.",
    "Rules:",
    "- Choose ONLY from the listed tags. Never invent a tag.",
    "- If the request does not clearly match a listed capability, answer none.",
    'Respond ONLY with JSON: {"capability": "<tag-or-none>"}. No prose.',
  ].join("\n");
  const prompt = [
    `Surface: ${surface}`,
    "Capabilities:",
    ...lines,
    "",
    `User request:\n${text}`,
    "",
    "Return the JSON now.",
  ].join("\n");
  return { system, prompt };
}

const ChosenSchema = z.object({ capability: z.string() });

/** Parse the model reply; accept ONLY a tag that was actually offered. */
function parseChosenCapability(
  text: string,
  candidateTags: ReadonlyArray<CapabilityTag>,
): CapabilityTag | null {
  const parsed = ChosenSchema.safeParse(extractJson(text));
  if (!parsed.success) return null;
  const raw = parsed.data.capability.trim();
  return candidateTags.find((t) => t === raw) ?? null;
}

/** Same lenient JSON extraction plan-lanes uses (fenced ```json, or first {..}). */
function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const s = trimmed.indexOf("{");
    const e = trimmed.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(trimmed.slice(s, e + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

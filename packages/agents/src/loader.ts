import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type {
  AgentManifest,
  AgentRole,
  AgentType,
  ModelRouting,
} from "./types.js";
import { CAPABILITY_SURFACES, CAPABILITY_TAGS, SOCIAL_AGENT_ROLES } from "./types.js";

export class RegistryLoadError extends Error {}

const EngineHandleSchema = z.discriminatedUnion("engine", [
  z.object({
    engine: z.literal("vertex"),
    model: z.union([z.literal("claude-sonnet-4-6"), z.literal("gemini-2-flash")]),
  }),
  z.object({
    engine: z.literal("bedrock"),
    model: z.union([
      z.literal("claude-haiku-4-5"),
      z.literal("claude-sonnet-4-6"),
      z.literal("claude-opus-4-6"),
    ]),
  }),
  z.object({
    engine: z.literal("claude"),
    model: z.union([
      z.literal("claude-haiku-4-5"),
      z.literal("claude-sonnet-4-6"),
      z.literal("claude-opus-4-6"),
    ]),
  }),
]);

const ManifestEscalationPredicateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("velocity_score_gte"), threshold: z.number() }),
  z.object({ kind: z.literal("never") }),
]);

// Capability tags and surfaces use the shared closed vocabulary.
const CapabilitySchema = z.object({
  handles: z.array(z.enum(CAPABILITY_TAGS)),
  surfaces: z.array(z.enum(CAPABILITY_SURFACES)),
  priority: z.number().int().optional(),
  intent_examples: z.array(z.string()).optional(),
});

const ManifestSchema = z.object({
  id: z.enum(SOCIAL_AGENT_ROLES),
  display_name: z.string(),
  short_description: z.string(),
  icon: z.string(),
  default_model: z.object({
    primary: EngineHandleSchema,
    fallback: EngineHandleSchema.optional(),
    escalation: EngineHandleSchema.and(
      z.object({ when: ManifestEscalationPredicateSchema }),
    ).optional(),
  }),
  default_bucket: z.string(),
  default_budget_cap_cents: z.number().int().positive(),
  tools: z.array(z.string()),
  hireable: z.boolean(),
  single_instance_per_org: z.boolean().optional(),
  capability: CapabilitySchema.optional(),
});

export function parseManifest(yamlText: string): AgentManifest {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new RegistryLoadError(`YAML parse error: ${String(err)}`);
  }
  const result = ManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new RegistryLoadError(
      `Manifest validation failed: ${result.error.message}`
    );
  }
  return result.data as AgentManifest;
}

const VelocityPayloadSchema = z.object({
  velocity_score: z.number().optional(),
});

export function compileRouting(manifest: AgentManifest): ModelRouting {
  const { default_model } = manifest;
  const routing: ModelRouting = {
    primary: default_model.primary,
  };

  if (default_model.fallback !== undefined) {
    routing.fallback = default_model.fallback;
  }

  if (default_model.escalation !== undefined) {
    const esc = default_model.escalation;
    const whenDecl = esc.when;
    let predicate: (ctx: import("./types.js").AgentCallContext) => boolean;

    if (whenDecl.kind === "velocity_score_gte") {
      const threshold = whenDecl.threshold;
      predicate = (ctx) => {
        const parsed = VelocityPayloadSchema.safeParse(ctx.payload);
        if (!parsed.success) return false;
        return (parsed.data.velocity_score ?? 0) >= threshold;
      };
    } else {
      predicate = () => false;
    }

    routing.escalation = {
      engine: { engine: esc.engine, model: esc.model } as import("./types.js").EngineHandle,
      when: predicate,
    };
    // The `as` cast is safe: EngineHandleSchema in ManifestSchema validates
    // engine+model as a discriminated union of the allowed pairs.
  }

  return routing;
}

export type Registry = {
  manifests: ReadonlyMap<AgentRole, AgentManifest>;
  agents: ReadonlyMap<AgentRole, AgentType>;
  get(role: AgentRole): AgentType;
  getManifest(role: AgentRole): AgentManifest;
};

/**
 * Load-time ambiguity guard for the routing substrate. Two roles declaring the
 * same `(capability tag, surface, priority)` triple would make the router's
 * tie-break non-deterministic, so we reject it at registry-build time. Roles may
 * share a `(tag, surface)` only with *distinct* priorities (an ordered set of
 * alternatives). Manifests without a `capability` facet are ignored.
 */
function assertCapabilityUnambiguous(
  manifests: Iterable<AgentManifest>,
): void {
  const seen = new Map<string, AgentRole>();
  for (const manifest of manifests) {
    const role = manifest.id;
    const cap = manifest.capability;
    if (cap === undefined) continue;
    for (const tag of cap.handles) {
      for (const surface of cap.surfaces) {
        const key = `${tag}|${surface}|${cap.priority ?? 0}`;
        const prior = seen.get(key);
        if (prior !== undefined && prior !== role) {
          throw new RegistryLoadError(
            `capability ambiguity: roles "${prior}" and "${role}" both declare ` +
              `(${tag}, ${surface}, priority=${cap.priority ?? 0}); give them ` +
              `distinct priorities or split the capability`,
          );
        }
        seen.set(key, role);
      }
    }
  }
}

export function buildRegistry(args: {
  manifestYamls: ReadonlyArray<{ filename: string; content: string }>;
  agentClasses: ReadonlyArray<AgentType>;
}): Registry {
  const manifestMap = new Map<AgentRole, AgentManifest>();

  for (const { filename, content } of args.manifestYamls) {
    let manifest: AgentManifest;
    try {
      manifest = parseManifest(content);
    } catch (err) {
      throw new RegistryLoadError(
        `Failed to parse ${filename}: ${String(err)}`
      );
    }
    manifestMap.set(manifest.id, manifest);
  }

  const classMap = new Map<AgentRole, AgentType>();
  for (const cls of args.agentClasses) {
    classMap.set(cls.id, cls);
  }

  const yamlIds = new Set(manifestMap.keys());
  const classIds = new Set(classMap.keys());

  const yamlOnly = [...yamlIds].filter((id) => !classIds.has(id));
  const classOnly = [...classIds].filter((id) => !yamlIds.has(id));

  if (yamlOnly.length > 0 || classOnly.length > 0) {
    throw new RegistryLoadError(
      `manifest/class mismatch: yamlOnly=[${yamlOnly.join(", ")}] classOnly=[${classOnly.join(", ")}]`
    );
  }

  assertCapabilityUnambiguous(manifestMap.values());

  const manifests: ReadonlyMap<AgentRole, AgentManifest> = manifestMap;
  const agents: ReadonlyMap<AgentRole, AgentType> = classMap;

  return {
    manifests,
    agents,
    get(role: AgentRole): AgentType {
      const agent = classMap.get(role);
      if (agent === undefined) {
        throw new RegistryLoadError(`no agent registered for role ${role}`);
      }
      return agent;
    },
    getManifest(role: AgentRole): AgentManifest {
      const manifest = manifestMap.get(role);
      if (manifest === undefined) {
        throw new RegistryLoadError(`no manifest registered for role ${role}`);
      }
      return manifest;
    },
  };
}

export function loadRegistryFromDisk(args: {
  registryDir?: string;
  agentClasses: ReadonlyArray<AgentType>;
}): Registry {
  const registryDir =
    args.registryDir ??
    join(dirname(fileURLToPath(import.meta.url)), "registry");

  const filenames = readdirSync(registryDir).filter((f) =>
    f.endsWith(".yaml")
  );

  const manifestYamls = filenames.map((filename) => ({
    filename,
    content: readFileSync(`${registryDir}/${filename}`, "utf-8"),
  }));

  return buildRegistry({ manifestYamls, agentClasses: args.agentClasses });
}

/**
 * Load just the parsed manifests from disk — no agent classes, no class/manifest
 * cross-check. This is the lean entry point for the capability router: a routing
 * consumer needs the `capability` facets, not the runnable agent classes. Still
 * runs the ambiguity guard so a bad manifest set fails loudly, exactly like
 * {@link buildRegistry}.
 */
export function loadManifestsFromDisk(registryDir?: string): AgentManifest[] {
  const dir =
    registryDir ?? join(dirname(fileURLToPath(import.meta.url)), "registry");

  const manifests = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((filename) => {
      try {
        return parseManifest(readFileSync(`${dir}/${filename}`, "utf-8"));
      } catch (err) {
        throw new RegistryLoadError(`Failed to parse ${filename}: ${String(err)}`);
      }
    });

  assertCapabilityUnambiguous(manifests);
  return manifests;
}

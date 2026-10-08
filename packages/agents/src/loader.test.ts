import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildRegistry,
  compileRouting,
  loadManifestsFromDisk,
  parseManifest,
  RegistryLoadError,
} from "./loader.js";
import { CAPABILITY_TAGS } from "./types.js";
import type { AgentRole, AgentType } from "./types.js";

const stub = (id: AgentRole, defaultBucket: string): AgentType => ({
  id,
  defaultBucket,
  defaultModel: { primary: { engine: "bedrock", model: "claude-sonnet-4-6" } },
  tools: [],
  render: async () => null,
});

const LINKEDIN_INTERN_YAML = `
id: linkedin_intern
display_name: "LinkedIn Growth Intern"
short_description: "Drafts LinkedIn comments and messages."
icon: "crown"
default_model:
  primary:
    engine: bedrock
    model: claude-sonnet-4-6
  fallback:
    engine: vertex
    model: claude-sonnet-4-6
default_bucket: drafter
default_budget_cap_cents: 5000
tools: []
hireable: true
single_instance_per_org: true
`.trim();

const REDDIT_INTERN_YAML = `
id: reddit_intern
display_name: "Reddit Growth Intern"
short_description: "Drafts replies to relevant Reddit threads."
icon: "megaphone"
default_model:
  primary:
    engine: bedrock
    model: claude-sonnet-4-6
  fallback:
    engine: vertex
    model: claude-sonnet-4-6
default_bucket: drafter
default_budget_cap_cents: 5000
tools: []
hireable: true
single_instance_per_org: true
`.trim();

const X_INTERN_YAML = `
id: x_intern
display_name: "X Growth Intern"
short_description: "Drafts on-brand X replies to monitored leads. You approve each one."
icon: "bird"
default_model:
  primary:
    engine: bedrock
    model: claude-sonnet-4-6
  fallback:
    engine: vertex
    model: claude-sonnet-4-6
  escalation:
    engine: bedrock
    model: claude-opus-4-6
    when:
      kind: velocity_score_gte
      threshold: 80
default_bucket: drafter
default_budget_cap_cents: 10000
tools:
  - nella.search
  - leads.claim
  - drafts.post
hireable: true
single_instance_per_org: false
`.trim();

describe("parseManifest", () => {
  it("accepts a valid linkedin_intern.yaml-style string and returns a typed AgentManifest", () => {
    const manifest = parseManifest(LINKEDIN_INTERN_YAML);
    expect(manifest.id).toBe("linkedin_intern");
    expect(manifest.display_name).toBe("LinkedIn Growth Intern");
    expect(manifest.default_model.primary).toEqual({
      engine: "bedrock",
      model: "claude-sonnet-4-6",
    });
    expect(manifest.default_model.fallback).toEqual({ engine: "vertex", model: "claude-sonnet-4-6" });
    expect(manifest.hireable).toBe(true);
    expect(manifest).not.toHaveProperty("reports_to");
    expect(manifest).not.toHaveProperty("tier");
    expect(manifest).not.toHaveProperty("provisioning");
  });

  it("rejects when required fields are missing (missing display_name)", () => {
    const yaml = LINKEDIN_INTERN_YAML.replace(/display_name:.*\n/, "");
    expect(() => parseManifest(yaml)).toThrow(RegistryLoadError);
  });

  it("rejects an unknown escalation.when.kind", () => {
    const yaml = X_INTERN_YAML.replace("velocity_score_gte", "unknown_kind");
    expect(() => parseManifest(yaml)).toThrow(RegistryLoadError);
  });

  it("rejects an invalid escalation engine/model pair", () => {
    // gemini-2-flash is a real model on `vertex`, but never on `bedrock` —
    // the union should reject this pairing.
    const yaml = X_INTERN_YAML.replace(
      /engine: bedrock\s+model: claude-opus-4-6/,
      "engine: bedrock\n    model: gemini-2-flash",
    );
    expect(() => parseManifest(yaml)).toThrow(RegistryLoadError);
  });
});

describe("retired roles", () => {
  it.each(["ceo", "cmo"])("rejects %s in executable manifests", (role) => {
    expect(() => parseManifest(LINKEDIN_INTERN_YAML.replace("id: linkedin_intern", `id: ${role}`))).toThrow(RegistryLoadError);
  });
});

describe("compileRouting", () => {
  it("produces a routing whose escalation.when predicate fires for velocity_score=99 and not for 50", () => {
    const manifest = parseManifest(X_INTERN_YAML);
    const routing = compileRouting(manifest);

    expect(routing.escalation).toBeDefined();

    const makeCtx = (score: number) => ({
      orgId: "org-1",
      instanceId: "inst-1",
      bucket: "drafter",
      routing,
      log: () => undefined,
      payload: { velocity_score: score },
    });

    expect(routing.escalation!.when(makeCtx(99))).toBe(true);
    expect(routing.escalation!.when(makeCtx(80))).toBe(true);
    expect(routing.escalation!.when(makeCtx(50))).toBe(false);
    expect(routing.escalation!.when(makeCtx(79))).toBe(false);
  });

  it("returns undefined for escalation when the manifest omits it (linkedin_intern/reddit_intern case)", () => {
    const manifest = parseManifest(LINKEDIN_INTERN_YAML);
    const routing = compileRouting(manifest);
    expect(routing.escalation).toBeUndefined();

    const reddit_intern = parseManifest(REDDIT_INTERN_YAML);
    const reddit_internRouting = compileRouting(reddit_intern);
    expect(reddit_internRouting.escalation).toBeUndefined();
  });
});

describe("buildRegistry", () => {
  it("happy path: two YAMLs + two stubs → get and getManifest work", () => {
    const registry = buildRegistry({
      manifestYamls: [
        { filename: "linkedin_intern.yaml", content: LINKEDIN_INTERN_YAML },
        { filename: "reddit_intern.yaml", content: REDDIT_INTERN_YAML },
      ],
      agentClasses: [stub("linkedin_intern", "drafter"), stub("reddit_intern", "drafter")],
    });

    const linkedin_internClass = registry.get("linkedin_intern");
    expect(linkedin_internClass.id).toBe("linkedin_intern");
    expect(linkedin_internClass.defaultBucket).toBe("drafter");

    const linkedin_internManifest = registry.getManifest("linkedin_intern");
    expect(linkedin_internManifest.id).toBe("linkedin_intern");
    expect(linkedin_internManifest.display_name).toBe("LinkedIn Growth Intern");

    expect(registry.manifests.size).toBe(2);
    expect(registry.agents.size).toBe(2);
  });

  it("throws when there is a yaml without a matching class", () => {
    expect(() =>
      buildRegistry({
        manifestYamls: [
          { filename: "linkedin_intern.yaml", content: LINKEDIN_INTERN_YAML },
          { filename: "reddit_intern.yaml", content: REDDIT_INTERN_YAML },
        ],
        agentClasses: [stub("linkedin_intern", "drafter")],
      })
    ).toThrow(RegistryLoadError);
  });

  it("throws when there is a class without a matching yaml", () => {
    expect(() =>
      buildRegistry({
        manifestYamls: [{ filename: "linkedin_intern.yaml", content: LINKEDIN_INTERN_YAML }],
        agentClasses: [stub("linkedin_intern", "drafter"), stub("reddit_intern", "drafter")],
      })
    ).toThrow(RegistryLoadError);
  });
});

describe("round-trip on real on-disk YAMLs", () => {
  it("reads all three YAML files, builds registry, and x_intern escalation fires for velocity_score=99", async () => {
    const registryDir = fileURLToPath(new URL("./registry/", import.meta.url));

    const [linkedin_internContent, reddit_internContent, xInternContent] = await Promise.all([
      readFile(`${registryDir}/linkedin_intern.yaml`, "utf-8"),
      readFile(`${registryDir}/reddit_intern.yaml`, "utf-8"),
      readFile(`${registryDir}/x_intern.yaml`, "utf-8"),
    ]);

    const registry = buildRegistry({
      manifestYamls: [
        { filename: "linkedin_intern.yaml", content: linkedin_internContent },
        { filename: "reddit_intern.yaml", content: reddit_internContent },
        { filename: "x_intern.yaml", content: xInternContent },
      ],
      agentClasses: [
        stub("linkedin_intern", "drafter"),
        stub("reddit_intern", "drafter"),
        stub("x_intern", "drafter"),
      ],
    });

    expect(registry.get("linkedin_intern").id).toBe("linkedin_intern");
    expect(registry.get("reddit_intern").id).toBe("reddit_intern");
    expect(registry.get("x_intern").id).toBe("x_intern");

    const xManifest = registry.getManifest("x_intern");
    const routing = compileRouting(xManifest);

    const ctx = {
      orgId: "org-1",
      instanceId: "inst-1",
      bucket: "drafter",
      routing,
      log: () => undefined,
      payload: { velocity_score: 99 },
    };

    expect(routing.escalation).toBeDefined();
    expect(routing.escalation!.when(ctx)).toBe(true);

    const ctxLow = { ...ctx, payload: { velocity_score: 50 } };
    expect(routing.escalation!.when(ctxLow)).toBe(false);
  });
});

// A capability facet appended to a valid x_intern manifest.
const X_WITH_CAP = `${X_INTERN_YAML}
capability:
  handles:
    - engagement.reply.x
  surfaces:
    - agent_chat
  priority: 3
  intent_examples:
    - "draft a reply to this tweet"
`;

describe("ManifestSchema capability facet (optional)", () => {
  it("parses the capability facet when present", () => {
    const manifest = parseManifest(X_WITH_CAP);
    expect(manifest.capability).toEqual({
      handles: ["engagement.reply.x"],
      surfaces: ["agent_chat"],
      priority: 3,
      intent_examples: ["draft a reply to this tweet"],
    });
  });

  it("is optional: a manifest without it parses with capability undefined", () => {
    const manifest = parseManifest(LINKEDIN_INTERN_YAML);
    expect(manifest.capability).toBeUndefined();
  });

  it("rejects an unknown capability tag (closed vocabulary)", () => {
    const bad = `${X_INTERN_YAML}
capability:
  handles:
    - engagement.reply.telegram
  surfaces:
    - agent_chat
`;
    expect(() => parseManifest(bad)).toThrow(RegistryLoadError);
  });

  it("rejects an unknown surface (closed vocabulary)", () => {
    const bad = `${X_INTERN_YAML}
capability:
  handles:
    - engagement.reply.x
  surfaces:
    - carrier_pigeon
`;
    expect(() => parseManifest(bad)).toThrow(RegistryLoadError);
  });
});

describe("buildRegistry capability ambiguity guard", () => {
  const capYaml = (
    id: AgentRole,
    tag: string,
    surface: string,
    priority?: number,
  ) => `
id: ${id}
display_name: "${id}"
short_description: "x"
icon: "dot"
default_model:
  primary:
    engine: bedrock
    model: claude-sonnet-4-6
default_bucket: drafter
default_budget_cap_cents: 1000
tools: []
hireable: true
capability:
  handles:
    - ${tag}
  surfaces:
    - ${surface}${priority === undefined ? "" : `\n  priority: ${priority}`}
`.trim();

  it("throws when two roles declare the same (tag, surface, priority)", () => {
    expect(() =>
      buildRegistry({
        manifestYamls: [
          { filename: "x.yaml", content: capYaml("x_intern", "engagement.reply.x", "agent_chat") },
          { filename: "r.yaml", content: capYaml("reddit_intern", "engagement.reply.x", "agent_chat") },
        ],
        agentClasses: [stub("x_intern", "drafter"), stub("reddit_intern", "drafter")],
      }),
    ).toThrow(RegistryLoadError);
  });

  it("allows two roles to share (tag, surface) with DISTINCT priorities (ordered alternatives)", () => {
    expect(() =>
      buildRegistry({
        manifestYamls: [
          { filename: "x.yaml", content: capYaml("x_intern", "engagement.reply.x", "agent_chat", 1) },
          { filename: "r.yaml", content: capYaml("reddit_intern", "engagement.reply.x", "agent_chat", 2) },
        ],
        agentClasses: [stub("x_intern", "drafter"), stub("reddit_intern", "drafter")],
      }),
    ).not.toThrow();
  });
});

describe("capability vocabulary coverage (on-disk registry)", () => {
  it("all four manifests parse, and every handled tag is a member of CAPABILITY_TAGS", () => {
    const manifests = loadManifestsFromDisk();
    expect(manifests).toHaveLength(4);
    for (const m of manifests) {
      for (const tag of m.capability?.handles ?? []) {
        expect(CAPABILITY_TAGS).toContain(tag);
      }
    }
  });

  it("the four intern capabilities each resolve to exactly one handler", () => {
    const manifests = loadManifestsFromDisk();
    const handlersFor = (tag: string) =>
      manifests.filter((m) => m.capability?.handles.includes(tag as (typeof CAPABILITY_TAGS)[number]));
    expect(handlersFor("content.video.script").map((m) => m.id)).toEqual(["video_intern"]);
    expect(handlersFor("engagement.reply.x").map((m) => m.id)).toEqual(["x_intern"]);
    expect(handlersFor("engagement.reply.linkedin").map((m) => m.id)).toEqual(["linkedin_intern"]);
    expect(handlersFor("engagement.reply.reddit").map((m) => m.id)).toEqual(["reddit_intern"]);
  });
});

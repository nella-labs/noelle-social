import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { X_FORM_VARIANTS, selectStyleExemplars } from "@noelle/runtime";
import { runDrafterTick } from "./drafter-tick.js";
import { listStyleExemplars, listStyleExemplarsForHandle } from "../lib/x-account-feeder-db.js";

vi.mock("../lib/x-account-feeder-db.js", () => ({
  listFeederSources: vi.fn(async () => [{ handle: "eliana_jordan", displayName: "Eliana" }]),
  listStyleExemplarsForHandle: vi.fn(async () => [{ account_handle: "eliana_jordan" }]),
  listStyleExemplars: vi.fn(async () => [{ account_handle: "eliana_jordan" }]),
  getUltraProfileForHandle: vi.fn(async () => null),
  listUltraProfiles: vi.fn(async () => []),
}));
vi.mock("@noelle/runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("@noelle/runtime")>(),
  selectStyleExemplars: vi.fn(async () => ({
    exemplars: [{ body: "the typo won again (naturally)", accountHandle: "eliana_jordan", likeCount: 8, commentCount: 1 }],
    styleNotes: "playful and lowercase",
  })),
}));

async function draftWithStyle(config: Record<string, unknown>, toneFirst = false) {
  const runner = { draft: vi.fn().mockResolvedValue({
    text: JSON.stringify({ drafts: [{ angle: "empathetic", body: "skill issue" }] }), engine: "codex", model: "test",
  }) };
  await runDrafterTick({
      patternRules: [],
    instance: { id: "instance", org_id: "org", account_feeder_config: config },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    claimedLeads: [{
      id: "lead", external_id: "post", author_handle: "peer", author_id: "peer", status: "drafting",
      tier: null, classifier_label: null, classifier_score: null, priority: false,
      payload: { text: toneFirst ? "shipped my first app today!" : "rust compile times doubled", energy: toneFirst ? "celebration" : undefined },
    }],
    runner: runner as never,
    kb: { search: vi.fn().mockResolvedValue([{ snippet: "i ship small", score: 8, filePath: "voice.md" }]) } as never,
    postOutbound: vi.fn().mockResolvedValue({ id: "draft", approval_id: "approval" }), markStatus: vi.fn(),
    sql: vi.fn().mockResolvedValue([]) as never,
    variety: { enabled: true, rng: () => 0.9, genzMarkerRate: 0,
      formVariantRotation: { next: () => X_FORM_VARIANTS.find((variant) => variant.id === "MICRO")! } },
    energy: { enabled: toneFirst },
  });
  return runner.draft.mock.calls[0]![0] as { system: string; prompt: string };
}

describe("X faithful style parity", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("NOELLE_DRAFTER_STYLE", "0"); });
  afterEach(() => vi.unstubAllEnvs());

  it("honors a pin with global style off and preserves its assigned tiny shape", async () => {
    const draft = await draftWithStyle({ pinnedStyleHandle: "eliana_jordan" });
    expect(listStyleExemplarsForHandle).toHaveBeenCalledTimes(1);
    expect(listStyleExemplarsForHandle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "comment" }));
    expect(selectStyleExemplars).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(),
      expect.objectContaining({ enabled: true, postRegister: undefined }));
    expect(draft.system).toContain("WRITE THIS REPLY IN THE VOICE OF THE WRITER BELOW");
    expect(draft.system).toContain(X_FORM_VARIANTS.find((variant) => variant.id === "MICRO")!.directive);
    expect(draft.system).not.toContain("THEN one line that actually adds something");
  });

  it.each([["comment"], ["post", "comment"]])("honors the configured exemplar kinds %j", async (...kinds) => {
    await draftWithStyle({ pinnedStyleHandle: "eliana_jordan", styleExemplarKinds: kinds });
    expect(vi.mocked(listStyleExemplarsForHandle).mock.calls.map(([, args]) => args.kind)).toEqual(kinds);
  });

  it("falls back to posts only for a faithful writer without comments", async () => {
    await vi.mocked(listStyleExemplarsForHandle).withImplementation(
      async (_sql, args) => {
        if (args.kind === "comment" && args.handle === "with_comments") {
          return [{ account_handle: "with_comments" }] as never;
        }
        if (args.kind === "post" && args.handle === "posts_only") {
          return [{ account_handle: "posts_only" }] as never;
        }
        return [];
      },
      async () => {
        await draftWithStyle({ faithfulVoices: ["with_comments", "posts_only"] });

        expect(vi.mocked(listStyleExemplarsForHandle).mock.calls.map(([, args]) => [args.handle, args.kind])).toEqual([
          ["with_comments", "comment"],
          ["posts_only", "comment"],
          ["posts_only", "post"],
        ]);
      },
    );
  });

  it("keeps tone-first register directions instead of imposing a hook plus line", async () => {
    const draft = await draftWithStyle({ pinnedStyleHandle: "eliana_jordan" }, true);
    expect(draft.system).toContain("WRITE THIS REPLY IN THE VOICE OF THE WRITER BELOW");
    expect(draft.prompt).toContain("ASSIGNED REGISTER");
    expect(draft.system).not.toContain("THEN one line that actually adds something");
  });

  it("keeps unpinned style off when the global switch is off", async () => {
    const draft = await draftWithStyle({});
    expect(listStyleExemplars).not.toHaveBeenCalled();
    expect(draft.system).not.toContain("WRITE THIS REPLY IN THE VOICE OF THE WRITER BELOW");
  });

  it("honors exemplar kinds in the automatic blend too", async () => {
    vi.stubEnv("NOELLE_DRAFTER_STYLE", "1");
    const draft = await draftWithStyle({ styleExemplarKinds: ["comment"] });
    expect(listStyleExemplars).toHaveBeenCalledTimes(1);
    expect(listStyleExemplars).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "comment" }));
    expect(draft.system).toContain("STYLE TO EMULATE");
    expect(draft.system).not.toContain("WRITE THIS REPLY IN THE VOICE OF THE WRITER BELOW");
  });
});

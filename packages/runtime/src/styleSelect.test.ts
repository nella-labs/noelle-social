import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectStyleExemplars, makeSeededRng, styleCheer01 } from "./styleSelect.js";
import type { StyleExemplarRow, UltraProfileRow } from "./styleTypes.js";

it("does not treat a non-cheer emoji's variation selector as cheer", () => {
  expect(styleCheer01("A warning ⚠️")).toBe(0);
  expect(styleCheer01("A plain variation selector \uFE0F")).toBe(0);
  expect(styleCheer01("A heart ❤️")).toBe(0.2);
  expect(styleCheer01("A heart ❤")).toBe(0.2);
});

// Unit tests for the per-lead STYLE selector (F6 §6.4). No DB, no network — the
// ranker fails open to input order without a VOYAGE_API_KEY, and we inject a
// fetch when we want to assert FIT explicitly. Every array access is guarded
// (CI typechecks tests under noUncheckedIndexedAccess).

// A corpus row factory. Engagement = like_count + comment_count.
function row(over: Partial<StyleExemplarRow> & { external_id: string }): StyleExemplarRow {
  return {
    external_id: over.external_id,
    body: over.body ?? `body ${over.external_id}`,
    like_count: over.like_count ?? 0,
    comment_count: over.comment_count ?? 0,
    account_handle: over.account_handle ?? "acct",
    posted_at: over.posted_at ?? null,
  };
}

// A Voyage /rerank fetch stub that ranks documents by an explicit external_id
// order (best first). Any document not named is appended in input order.
function rerankFetchByBody(orderBodies: string[]): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { documents: string[] };
    const docs = body.documents;
    const ranked = docs
      .map((doc, index) => {
        const pos = orderBodies.indexOf(doc);
        return { index, sortKey: pos === -1 ? Number.MAX_SAFE_INTEGER : pos };
      })
      .sort((a, b) => a.sortKey - b.sortKey);
    const data = ranked.map((r, i) => ({ index: r.index, relevance_score: 1 - i * 0.01 }));
    return Response.json({ data });
  }) as unknown as typeof fetch;
}

const NO_PROFILES: UltraProfileRow[] = [];

describe("measured style performance", () => {
  it("does not certify an unknown singleton against a positive performance floor", async () => {
    const unknown = { ...row({ external_id: "unknown" }), like_count: null, comment_count: null } as unknown as StyleExemplarRow;
    expect(await selectStyleExemplars("detail", [unknown], [], { enabled: true, apiKey: "",
      config: { minPerformancePercentile: 100, varietyTemperature: 0, maxStyleExemplars: 1 } })).toBeNull();
  });
  it("ranks a measured-zero singleton within measured rows instead of unknown peers", async () => {
    const unknown = { ...row({ external_id: "unknown" }), like_count: null, comment_count: null } as unknown as StyleExemplarRow;
    const selected = await selectStyleExemplars("detail", [unknown, row({ external_id: "zero" })], [], { enabled: true, apiKey: "",
      config: { minPerformancePercentile: 100, varietyTemperature: 0, maxStyleExemplars: 1 } });
    expect(selected?.exemplars.map(item => item.body)).toEqual(["body zero"]);
  });
});

describe("selectStyleExemplars — gate + fail-open", () => {
  const origKey = process.env["VOYAGE_API_KEY"];
  const origStyle = process.env["NOELLE_DRAFTER_STYLE"];
  beforeEach(() => {
    delete process.env["VOYAGE_API_KEY"]; // fail-open ranker (input order)
    delete process.env["NOELLE_DRAFTER_STYLE"];
  });
  afterEach(() => {
    if (origKey === undefined) delete process.env["VOYAGE_API_KEY"];
    else process.env["VOYAGE_API_KEY"] = origKey;
    if (origStyle === undefined) delete process.env["NOELLE_DRAFTER_STYLE"];
    else process.env["NOELLE_DRAFTER_STYLE"] = origStyle;
  });

  it("returns null when the gate is OFF (enabled:false)", async () => {
    const res = await selectStyleExemplars("lead", [row({ external_id: "a" })], NO_PROFILES, {
      enabled: false,
    });
    expect(res).toBeNull();
  });

  it("returns null when the gate is OFF via env (no enabled flag, no env)", async () => {
    const res = await selectStyleExemplars("lead", [row({ external_id: "a" })], NO_PROFILES, {});
    expect(res).toBeNull();
  });

  it("returns a selection when the gate is ON via env", async () => {
    process.env["NOELLE_DRAFTER_STYLE"] = "1";
    const res = await selectStyleExemplars("lead", [row({ external_id: "a" })], NO_PROFILES, {});
    expect(res).not.toBeNull();
    expect(res?.exemplars).toHaveLength(1);
  });

  it("returns null on an EMPTY pool even when enabled", async () => {
    const res = await selectStyleExemplars("lead", [], NO_PROFILES, { enabled: true });
    expect(res).toBeNull();
  });

  it("returns null when maxStyleExemplars is 0 (operator disabled exemplars)", async () => {
    const res = await selectStyleExemplars("lead", [row({ external_id: "a" })], NO_PROFILES, {
      enabled: true,
      config: { maxStyleExemplars: 0 },
    });
    expect(res).toBeNull();
  });

  it("fails open to null when the injected rng throws (any error → null)", async () => {
    const res = await selectStyleExemplars("lead", [row({ external_id: "a" })], NO_PROFILES, {
      enabled: true,
      rng: () => {
        throw new Error("boom");
      },
    });
    expect(res).toBeNull();
  });

  it("never throws and stays fail-open even with a malformed config", async () => {
    const res = await selectStyleExemplars(
      "lead",
      [row({ external_id: "a" })],
      NO_PROFILES,
      { enabled: true, config: "not-an-object" as unknown },
    );
    // Bad config → schema defaults → still a valid selection (not a throw).
    expect(res).not.toBeNull();
  });
});

describe("selectStyleExemplars — performance × fit favouring", () => {
  it("with variety=0, favours the high-performing, well-fitting exemplar", async () => {
    // Three candidates. We make 'best' both the top-fit (ranked first) AND the
    // top-perf, so the deterministic blend must pick it.
    const candidates = [
      row({ external_id: "low", body: "low body", like_count: 1, comment_count: 0 }),
      row({ external_id: "best", body: "best body", like_count: 900, comment_count: 100 }),
      row({ external_id: "mid", body: "mid body", like_count: 50, comment_count: 0 }),
    ];
    const res = await selectStyleExemplars("the lead", candidates, NO_PROFILES, {
      enabled: true,
      config: { maxStyleExemplars: 1, varietyTemperature: 0 },
      fetchImpl: rerankFetchByBody(["best body", "mid body", "low body"]),
      apiKey: "test-key",
    });
    expect(res).not.toBeNull();
    expect(res?.exemplars).toHaveLength(1);
    expect(res?.exemplars[0]?.body).toBe("best body");
  });

  it("with variety=0, a high-FIT but low-perf exemplar still beats a low-fit high-perf one (fit weighted higher)", async () => {
    // 'fit' is ranked first (best fit) but low perf; 'pop' is ranked last (worst
    // fit) but highest perf. W_FIT(0.6) > W_PERF(0.4) → 'fit' wins the top slot.
    const candidates = [
      row({ external_id: "pop", body: "pop body", like_count: 1000, comment_count: 0 }),
      row({ external_id: "fit", body: "fit body", like_count: 0, comment_count: 0 }),
      row({ external_id: "mid", body: "mid body", like_count: 10, comment_count: 0 }),
    ];
    const res = await selectStyleExemplars("the lead", candidates, NO_PROFILES, {
      enabled: true,
      config: { maxStyleExemplars: 1, varietyTemperature: 0 },
      fetchImpl: rerankFetchByBody(["fit body", "mid body", "pop body"]),
      apiKey: "test-key",
    });
    expect(res?.exemplars[0]?.body).toBe("fit body");
  });

  it("respects maxStyleExemplars (picks exactly N)", async () => {
    const candidates = Array.from({ length: 8 }, (_, i) =>
      row({ external_id: `c${i}`, like_count: i * 10 }),
    );
    const res = await selectStyleExemplars("lead", candidates, NO_PROFILES, {
      enabled: true,
      config: { maxStyleExemplars: 3, varietyTemperature: 0 },
    });
    expect(res?.exemplars).toHaveLength(3);
  });
});

describe("selectStyleExemplars — variety", () => {
  // With high varietyTemperature and the default per-lead seeded rng, the chosen
  // top exemplar should VARY across different lead texts. With variety=0 it must
  // be identical regardless of the lead text.
  function pool(): StyleExemplarRow[] {
    return Array.from({ length: 12 }, (_, i) =>
      row({ external_id: `c${i}`, body: `body ${i}`, like_count: 100 + i, comment_count: 0 }),
    );
  }

  async function topFor(
    leadText: string,
    varietyTemperature: number,
  ): Promise<string | undefined> {
    const res = await selectStyleExemplars(leadText, pool(), NO_PROFILES, {
      enabled: true,
      config: { maxStyleExemplars: 1, varietyTemperature },
      // No fetchImpl / no key → ranker fails open to input order (deterministic
      // fit), so the ONLY thing that changes the pick across leads is the
      // per-lead-seeded variety noise.
    });
    return res?.exemplars[0]?.body;
  }

  it("variety=0 picks the same exemplar regardless of lead text (deterministic)", async () => {
    const a = await topFor("lead one", 0);
    const b = await topFor("a completely different lead", 0);
    const c = await topFor("yet another", 0);
    expect(a).toBeDefined();
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("high variety changes the pick across different lead texts", async () => {
    const leads = [
      "lead alpha",
      "lead bravo",
      "charlie post",
      "delta delta",
      "echo echo echo",
      "foxtrot here",
      "golf post text",
      "hotel hotel",
    ];
    const picks = new Set<string>();
    for (const l of leads) {
      const t = await topFor(l, 1);
      if (t) picks.add(t);
    }
    // With max variety + 8 distinct seeds over a 12-item pool, the picks must
    // spread across more than one exemplar (a deterministic selector would yield
    // exactly one). This is the "variety changes the pick per lead" assertion.
    expect(picks.size).toBeGreaterThan(1);
  });

  it("the seeded PRNG is deterministic per seed but differs across seeds", () => {
    const r1 = makeSeededRng("seed-x");
    const r2 = makeSeededRng("seed-x");
    const r3 = makeSeededRng("seed-y");
    const a = r1();
    const b = r2();
    expect(a).toBe(b); // same seed → same stream
    // different seed → (almost surely) a different first draw
    expect(r3()).not.toBe(a);
    // values are in [0,1)
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });
});

describe("selectStyleExemplars — minPerformancePercentile floor", () => {
  it("excludes below-floor exemplars from the output", async () => {
    // 10 candidates with engagement 0..9. A 60th-percentile floor keeps roughly
    // the top ~40% (those with strictly fewer-lower neighbours past the cut).
    const candidates = Array.from({ length: 10 }, (_, i) =>
      row({ external_id: `c${i}`, body: `body ${i}`, like_count: i, comment_count: 0 }),
    );
    const res = await selectStyleExemplars("lead", candidates, NO_PROFILES, {
      enabled: true,
      config: { maxStyleExemplars: 10, varietyTemperature: 0, minPerformancePercentile: 60 },
    });
    expect(res).not.toBeNull();
    const bodies = (res?.exemplars ?? []).map((e) => e.body);
    // The very lowest performers (engagement 0,1,2) must be floored out.
    expect(bodies).not.toContain("body 0");
    expect(bodies).not.toContain("body 1");
    expect(bodies).not.toContain("body 2");
    // The top performer survives.
    expect(bodies).toContain("body 9");
  });

  it("a 100 floor with a flat-engagement pool floors everything → null", async () => {
    // All equal engagement → percent_rank is 0 for all → nothing clears a 100
    // floor → fail-open null.
    const candidates = Array.from({ length: 5 }, (_, i) =>
      row({ external_id: `c${i}`, like_count: 5, comment_count: 0 }),
    );
    const res = await selectStyleExemplars("lead", candidates, NO_PROFILES, {
      enabled: true,
      config: { maxStyleExemplars: 3, minPerformancePercentile: 100 },
    });
    expect(res).toBeNull();
  });

  it("a 0 floor (default) keeps the whole pool eligible", async () => {
    const candidates = Array.from({ length: 4 }, (_, i) =>
      row({ external_id: `c${i}`, like_count: i }),
    );
    const res = await selectStyleExemplars("lead", candidates, NO_PROFILES, {
      enabled: true,
      config: { maxStyleExemplars: 4, varietyTemperature: 0, minPerformancePercentile: 0 },
    });
    expect(res?.exemplars).toHaveLength(4);
  });
});

describe("selectStyleExemplars — styleNotes", () => {
  it("attaches matched accounts' ultra-profile notes", async () => {
    const candidates = [row({ external_id: "a", body: "hook body", account_handle: "guru" })];
    const profiles: UltraProfileRow[] = [
      {
        account_handle: "guru",
        voice_summary: "punchy and direct",
        tone: "dry",
        structure_notes: "one-liners, no fluff",
        hook_patterns: ["starts with a bold claim"],
        signature_phrases: ["here's the thing"],
        top_topics: ["devtools"],
      },
    ];
    const res = await selectStyleExemplars("lead", candidates, profiles, {
      enabled: true,
      config: { maxStyleExemplars: 1, varietyTemperature: 0 },
    });
    expect(res?.styleNotes).toContain("punchy and direct");
    expect(res?.styleNotes).toContain("here's the thing");
  });

  it("returns empty styleNotes when no ultra profile matches the chosen account", async () => {
    const candidates = [row({ external_id: "a", account_handle: "unknown-acct" })];
    const res = await selectStyleExemplars("lead", candidates, NO_PROFILES, {
      enabled: true,
      config: { maxStyleExemplars: 1, varietyTemperature: 0 },
    });
    expect(res).not.toBeNull();
    expect(res?.styleNotes).toBe("");
  });
});

describe("selectStyleExemplars — post-register cheer bias", () => {
  // The SAME pool + input order; only postRegister differs. A calm analytical
  // exemplar (best fit, low engagement) and a cheery one (worse fit, high
  // engagement). Celebration must surface the cheery one; neutral must surface
  // the calm one (an analytical reply should not learn its form from "omg!!!").
  const calm = row({
    external_id: "calm",
    body: "the retainer-first move is the tell every time",
    like_count: 0,
    comment_count: 0,
    account_handle: "k",
  });
  const cheery = row({
    external_id: "cheery",
    body: "omg congrats this is amazing!!! 🥳",
    like_count: 100,
    comment_count: 0,
    account_handle: "k",
  });

  it("celebration surfaces the CHEERING exemplar", async () => {
    const res = await selectStyleExemplars("we just shipped!!", [calm, cheery], NO_PROFILES, {
      enabled: true,
      config: { maxStyleExemplars: 1, varietyTemperature: 0 },
      postRegister: "celebration",
    });
    expect(res?.exemplars[0]?.body).toBe(cheery.body);
  });

  it("neutral surfaces the CALM exemplar (penalizes cheeriness)", async () => {
    const res = await selectStyleExemplars(
      "here's why most pipelines degrade",
      [calm, cheery],
      NO_PROFILES,
      {
        enabled: true,
        config: { maxStyleExemplars: 1, varietyTemperature: 0 },
        postRegister: "neutral",
      },
    );
    expect(res?.exemplars[0]?.body).toBe(calm.body);
  });

  it("omitting postRegister preserves the legacy fit-led pick (no cheer term)", async () => {
    // Legacy blend (W_FIT 0.6 > W_PERF 0.4): the best-fit calm exemplar leads.
    const res = await selectStyleExemplars("any lead", [calm, cheery], NO_PROFILES, {
      enabled: true,
      config: { maxStyleExemplars: 1, varietyTemperature: 0 },
    });
    expect(res?.exemplars[0]?.body).toBe(calm.body);
  });
});

describe("styleCheer01", () => {
  it("scores cheering writing high and calm writing ~0", () => {
    expect(styleCheer01("omg congrats this is amazing!!! 🥳")).toBeGreaterThan(0.5);
    expect(styleCheer01("YAYYYY YOU'RE DONE!!!!! 🥳🥳🥳")).toBeGreaterThan(0.5);
    expect(styleCheer01("the retainer-first move is the tell every time")).toBe(0);
  });

  it("is clamped to [0,1] and handles empty input", () => {
    expect(styleCheer01("CONGRATS!!! AMAZING!!! HUGE!!! LETS GO!!! 🎉🥳🙌")).toBeLessThanOrEqual(1);
    expect(styleCheer01("")).toBe(0);
  });
});

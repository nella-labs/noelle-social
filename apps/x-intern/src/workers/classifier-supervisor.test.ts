import { beforeEach, expect, it } from "vitest";
import {
  boot,
  inst,
  reset,
  getState,
  sourceLead,
  usage,
  verdict,
} from "./classifier-supervisor-fixture.js";
const state = getState();
beforeEach(reset);

it("does not claim paid watchlist work after the tick precheck denies its budget", async () => {
  await boot();
  await state.onTick!(inst);
  expect(state.provider).not.toHaveBeenCalled();
  expect(state.claim).not.toHaveBeenCalled();
});
it("restores rejected admission claims without waiting for stale recovery", async () => {
  state.atCap = false;
  await boot();
  await state.onTick!(inst);
  expect(state.provider).not.toHaveBeenCalled();
  expect(state.claim).toHaveBeenCalledOnce();
  expect(state.release).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      orgId: "org",
      agentInstanceId: "instance",
      claims: [expect.objectContaining({ id: "lead", classification_claimed_at: "lease-1" })],
    }),
  );
});

it("runs the shared deterministic eligibility gates before a paid batch", async () => {
  state.cli = true;
  state.atCap = false;
  state.reserveDenied = false;
  state.claim.mockResolvedValue([
    sourceLead("aged", {
      text: "We shipped a database migration tool",
      posted_at: "2020-01-01T00:00:00.000Z",
    }),
    {
      ...sourceLead("language", {
        text: "Estoy muy feliz de anunciar que hemos lanzado nuestro nuevo proyecto. Gracias a todos por su apoyo y por compartir esta experiencia con nosotros.",
      }),
      priority: true,
    },
  ]);
  state.provider.mockResolvedValue({
    text: JSON.stringify(
      [0, 1].map((id) => ({
        id,
        on_brand: true,
        on_brand_reason: "ok",
        kind: "launch",
        velocity_score: 90,
        q: 90,
        reply_kind: "substantial",
        tier: "T1",
      })),
    ),
    usage: { input_tokens: 20, output_tokens: 20, cost_usd: 0 },
  });
  await boot();
  await state.onTick!(inst);
  expect(state.writes.flat()).toContain("too_old");
  expect(state.writes.flat()).toContain("non_english");
  expect(state.provider).not.toHaveBeenCalled();
});

it("maps a reordered eligible batch to its actual leads after excluding stale and off-ICP posts", async () => {
  state.cli = true;
  state.atCap = false;
  state.reserveDenied = false;
  state.claim.mockResolvedValue([
    sourceLead("old", { posted_at: "2020-01-01T00:00:00.000Z" }),
    sourceLead("substantial", { author_bio: "founder of a database tool" }),
    sourceLead("off-icp", { author_bio: "crypto promotions and token giveaways" }),
    sourceLead("light", { author_bio: "founder shipping a new tool" }),
  ]);
  state.provider.mockResolvedValue({
    text: JSON.stringify([verdict(1, 60, "light"), verdict(0, 93)]),
    usage,
  });
  await boot();
  await state.onTick!({
    ...inst,
    icp_config: { headlineKeywords: ["founder"], headlineExcludeKeywords: ["crypto"] },
  });
  expect(state.provider).toHaveBeenCalledOnce();
  const inputs = JSON.parse(state.provider.mock.calls[0]![0].prompt);
  expect(inputs.map((input: { postText: string }) => input.postText)).toEqual([
    sourceLead("substantial").payload.text,
    sourceLead("light").payload.text,
  ]);
  const saved = new Map(state.writes.map((values) => [values.at(-1), values]));
  expect(saved.get("old")?.slice(0, 2)).toEqual(["skipped", "too_old"]);
  expect(saved.get("off-icp")?.slice(0, 2)).toEqual(["skipped", "off_icp"]);
  expect(saved.get("substantial")?.slice(0, 4)).toEqual(["classified", "question", 0.93, "T1"]);
  expect(saved.get("light")?.slice(0, 4)).toEqual(["classified", "light", 0.6, null]);
  expect(state.release).not.toHaveBeenCalled();
});

it("releases all unchanged claims when batch admission is rejected", async () => {
  state.cli = true;
  state.atCap = false;
  const claims = [sourceLead("one"), sourceLead("two")];
  state.claim.mockResolvedValue(claims);
  await boot();
  await expect(state.onTick!(inst)).rejects.toBeInstanceOf(Error);
  expect(state.provider).not.toHaveBeenCalled();
  expect(state.release).toHaveBeenCalledWith(expect.anything(), {
    orgId: "org",
    agentInstanceId: "instance",
    claims,
  });
  expect(state.finish).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
});

it("releases only rejected per-post claims while retaining a successfully classified sibling", async () => {
  state.atCap = false;
  state.reserveDenied = false;
  state.denyFirst = true;
  const claims = [sourceLead("denied"), sourceLead("accepted")];
  state.claim.mockResolvedValue(claims);
  state.provider.mockResolvedValue({ text: JSON.stringify(verdict(0)), usage });
  await boot();
  await state.onTick!(inst);
  expect(state.provider).toHaveBeenCalledOnce();
  expect(state.release).toHaveBeenCalledWith(expect.anything(), {
    orgId: "org",
    agentInstanceId: "instance",
    claims: [claims[0]],
  });
  expect(
    state.writes.some((values) => values.at(-1) === "accepted" && values[0] === "classified"),
  ).toBe(true);
  expect(state.finish).toHaveBeenCalledWith({ status: "ok", rowsProcessed: 1 });
});

it("retains the BYO backend policy without admitting Noelle-billed work", async () => {
  state.byo = true;
  state.provider.mockResolvedValue({ text: JSON.stringify(verdict(0)), usage });
  await boot();
  await state.onTick!(inst);
  expect(state.claim).toHaveBeenCalledOnce();
  expect(state.provider).toHaveBeenCalledOnce();
  expect(state.release).not.toHaveBeenCalled();
  expect(state.writes.some((values) => values[0] === "classified")).toBe(true);
});

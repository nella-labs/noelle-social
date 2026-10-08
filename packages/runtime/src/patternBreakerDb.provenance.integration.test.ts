import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as owner from "./patternBreakerDb.js";
import {
  setup,
  reset,
  close,
  sql,
  reboundOrg,
  instance,
  scope,
  rule,
  alert,
  reply,
  corpus,
  persist,
  claim,
  apply,
} from "./patternBreakerDb.fixture.js";
const url = process.env.PATTERN_REFINER_DATABASE_URL;
describe.skipIf(!url)("Pattern observation provenance (native)", () => {
  beforeAll(() => setup(url!));
  beforeEach(reset);
  afterAll(() => close(url!));
  it("creates one observation and no duplicate open alert", async () => {
    await reply();
    const first = await persist();
    expect(first).not.toBeNull();
    expect(await persist()).toBeNull();
    expect(await sql`select id from noelle.pattern_alerts`).toHaveLength(1);
  });
  it("never overwrites a standing manual instruction", async () => {
    await reply();
    const id = await rule({ label: "stock closer" });
    await sql`update noelle.pattern_rules set source='manual',instruction='Use only specific supportive observations' where id=${id}`;
    expect(await persist()).toBeNull();
    expect(
      (await sql`select instruction from noelle.pattern_rules where id=${id}`)[0]?.instruction,
    ).toBe("Use only specific supportive observations");
  });
  it("rejects an analyzed source body that changed during the model call", async () => {
    const id = await reply();
    const captured = await corpus();
    await sql`update noelle.drafts set payload=jsonb_set(payload,'{body}','"A changed useful reply"') where id=${id}`;
    expect(await persist("stock closer", { corpus: captured })).toBeNull();
  });
  it("rejects foreign source and parent ownership rather than admitting a false empty window", async () => {
    await reply();
    const captured = await corpus();
    await sql`update noelle.agent_instances set org_id=${reboundOrg} where id=${instance}`;
    expect(await persist("stock closer", { corpus: captured })).toBeNull();
  });
  it("keeps legacy style-only examples refinable but rejects supplied unavailable IDs", async () => {
    const r = await rule();
    const valid = await alert(r);
    const invalid = await alert(r);
    await sql`update noelle.pattern_alerts set examples=${sql.json([{ draftId: "00000000-0000-4000-8000-000000000099", snippet: "stock closer" }])} where id=${invalid}`;
    expect((await owner.loadRefiningAlerts(sql, scope)).map((row) => row.alert_id)).toEqual([
      valid,
    ]);
  });
  it("rejects a captured source edit after dispatch without promoting the rule", async () => {
    const id = await reply();
    const r = await rule();
    const a = await alert(r);
    await sql`update noelle.pattern_alerts set examples=${sql.json([{ draftId: id, snippet: "stock closer" }])} where id=${a}`;
    const c = await claim(a);
    await sql`update noelle.drafts set payload=jsonb_set(payload,'{body}','"Different useful stock closer"') where id=${id}`;
    expect(await apply(c)).toBe(false);
    expect((await sql`select source from noelle.pattern_rules where id=${r}`)[0]?.source).toBe(
      "auto",
    );
  });
});

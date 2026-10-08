import { describe, expect, it, vi } from "vitest";
import type { NoelleContext } from "../context.js";
import { personsModule } from "./persons.js";

function context() {
  const writes: string[] = [];
  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join("$");
      if (query.includes("insert into")) writes.push(query);
      return query.includes("insert into noelle.persons") ? [{ id: "person" }] : [];
    }),
    { begin: async (write: (tx: unknown) => Promise<unknown>) => write(sql) },
  );
  return {
    writes,
    ctx: {
      sql,
      assertWritable: vi.fn(),
      resolveOrg: async () => ({ orgId: "org", slug: "one", name: "One" }),
    } as unknown as NoelleContext,
  };
}

describe("person creation admission", () => {
  it.each([
    { platform: "unsupported", handle: "ada" },
    { platform: "unsupported" },
    { platform: "x" },
    { platform: "linkedin", url: " " },
    { handle: "ada" },
    { url: "https://example.com/ada" },
  ])("refuses an invalid initial account before any insert: %j", async (account) => {
    const { ctx, writes } = context();
    const result = await personsModule.handle(
      "noelle_add_person",
      { displayName: "Ada", ...account },
      ctx,
    );
    expect(result).toMatchObject({ isError: true });
    expect(writes).toEqual([]);
  });

  it("keeps creation without an initial account supported", async () => {
    const { ctx, writes } = context();
    const result = await personsModule.handle("noelle_add_person", { displayName: "Ada" }, ctx);
    expect(result?.isError).not.toBe(true);
    expect(result?.content[0]?.text).toContain("id=person");
    expect(writes).toHaveLength(1);
  });

  it.each(["x", "linkedin", "reddit"])("creates a valid initial %s account", async (platform) => {
    const { ctx, writes } = context();
    const result = await personsModule.handle(
      "noelle_add_person",
      { displayName: "Ada", platform, handle: "ada" },
      ctx,
    );
    expect(result?.isError).not.toBe(true);
    expect(result?.content[0]?.text).toContain(`with ${platform} account @ada`);
    expect(writes).toHaveLength(2);
  });
});

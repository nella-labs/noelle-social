import { describe, expect, it, vi } from "vitest";
import type { NoelleContext } from "../context.js";
import { watchlistsModule } from "./watchlists.js";

function context(entries: Array<{ id: string; kind: string; value: string }> = []) {
  const queries: string[] = [];
  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("$");
      queries.push(query);
      if (query.includes("from noelle.agent_instances"))
        return [{ id: "instance", role: "x_intern", display_name: "Vega" }];
      if (query.includes("from noelle.x_watchlist_people")) return [];
      if (query.includes("from noelle.x_watchlist")) return entries;
      if (query.includes("from noelle.reddit_watchlist")) return [];
      if (query.includes("delete from"))
        return entries.filter((row) => values.includes(row.id)).map(({ id }) => ({ id }));
      throw new Error("Unexpected fixture query");
    }),
    {},
  );
  Object.assign(sql, { toString: () => "fixture" });
  return {
    queries,
    ctx: {
      sql: new Proxy(sql, {
        apply(target, receiver, args) {
          return typeof args[0] === "string" ? args[0] : Reflect.apply(target, receiver, args);
        },
      }),
      assertWritable: vi.fn(),
      resolveOrg: async () => ({ orgId: "org", slug: "one", name: "One" }),
    } as unknown as NoelleContext,
  };
}

describe("watchlist identifiers", () => {
  it.each(["handle", "keyword"])("lists a removable identifier for every X %s", async (kind) => {
    const entry = { id: `row-${kind}`, kind, value: "systems" };
    const { ctx } = context([entry]);
    const listed = await watchlistsModule.handle(
      "noelle_list_watchlist",
      { platform: "x", role: "x_intern" },
      ctx,
    );
    const output = listed?.content[0]?.text ?? "";
    expect(output).toContain(`| ${entry.id} |`);
    expect(output).toContain(`| ${kind} |`);
    const removed = await watchlistsModule.handle(
      "noelle_remove_watchlist_entry",
      { platform: "x", role: "x_intern", kind, rowId: entry.id },
      ctx,
    );
    expect(removed?.isError).not.toBe(true);
    expect(removed?.content[0]?.text).toContain(`Removed watchlist entry ${entry.id}`);
  });

  it("keeps measured empty watchlists explicit", async () => {
    const { ctx } = context();
    const listed = await watchlistsModule.handle(
      "noelle_list_watchlist",
      { platform: "x", role: "x_intern" },
      ctx,
    );
    expect(listed?.content[0]?.text).toContain("_none_");
  });

  it.each(["unsupported", "__proto__", "constructor", "toString"])(
    "refuses %s without presenting the Reddit watchlist",
    async (platform) => {
      const { ctx, queries } = context();
      const listed = await watchlistsModule.handle(
        "noelle_list_watchlist",
        { platform, role: "x_intern" },
        ctx,
      );
      expect(listed).toMatchObject({ isError: true });
      expect(queries.some((query) => query.includes("from noelle.reddit_watchlist"))).toBe(false);
    },
  );
});

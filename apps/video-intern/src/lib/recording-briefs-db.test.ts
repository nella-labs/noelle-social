import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { claimReadyDraftsForBrief } from "./recording-briefs-db.js";

describe("recording brief admission limits", () => {
  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid limit %s before accessing the SQL resource", async limit => {
      let accesses = 0;
      const sql = new Proxy({} as Sql, { get() { accesses++; throw new Error("SQL resource must remain untouched"); } });
      await expect(claimReadyDraftsForBrief(sql, "instance", limit, "org")).rejects.toBeInstanceOf(RangeError);
      expect(accesses).toBe(0);
    },
  );
});

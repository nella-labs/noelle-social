import { describe, it, expect, vi } from "vitest";
import { applyPlan, type MirrorDeps } from "./mirror.js";

function makeDeps(): MirrorDeps & {
  writes: Array<{ filename: string; body: string }>;
  deletes: string[];
} {
  const writes: Array<{ filename: string; body: string }> = [];
  const deletes: string[] = [];
  return {
    writes,
    deletes,
    bucket: "noelle-vaults",
    prefix: "workspace/",
    deleteGuardPct: 25,
    readLocal: vi.fn(async (relPath: string) => `body-of-${relPath}`),
    storage: {
      writeText: vi.fn(async (a: { filename: string; body: string }) => {
        writes.push({ filename: a.filename, body: a.body });
      }),
      delete: vi.fn(async (a: { filename: string }) => {
        deletes.push(a.filename);
      }),
    },
  };
}

describe("applyPlan", () => {
  it("uploads each toUpload file with its local body", async () => {
    const deps = makeDeps();
    const res = await applyPlan({ toUpload: ["a.md", "b.md"], toDelete: [] }, 2, deps);
    expect(deps.writes).toEqual([
      { filename: "a.md", body: "body-of-a.md" },
      { filename: "b.md", body: "body-of-b.md" },
    ]);
    expect(res.uploaded).toBe(2);
    expect(res.deletesWithheld).toBe(0);
  });

  it("deletes when under the guard threshold", async () => {
    const deps = makeDeps();
    // 1 delete of 10 remote files = 10% < 25%
    const res = await applyPlan({ toUpload: [], toDelete: ["gone.md"] }, 10, deps);
    expect(deps.deletes).toEqual(["gone.md"]);
    expect(res.deleted).toBe(1);
    expect(res.deletesWithheld).toBe(0);
  });

  it("withholds deletes above the guard threshold unless forced (uploads still proceed)", async () => {
    const deps = makeDeps();
    // 5 deletes of 10 remote = 50% > 25%
    const res = await applyPlan(
      { toUpload: ["new.md"], toDelete: ["a.md", "b.md", "c.md", "d.md", "e.md"] },
      10,
      deps,
    );
    expect(deps.deletes).toEqual([]);
    expect(deps.writes).toEqual([{ filename: "new.md", body: "body-of-new.md" }]);
    expect(res.deletesWithheld).toBe(5);
    expect(res.deleted).toBe(0);
  });

  it("force=true deletes even above the threshold", async () => {
    const deps = makeDeps();
    const res = await applyPlan(
      { toUpload: [], toDelete: ["a.md", "b.md", "c.md", "d.md", "e.md"] },
      10,
      deps,
      { force: true },
    );
    expect(deps.deletes).toHaveLength(5);
    expect(res.deletesWithheld).toBe(0);
  });
});

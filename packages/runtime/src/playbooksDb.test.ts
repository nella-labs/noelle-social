import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { upsertPlaybook, type PlaybookUpsert } from "./playbooksDb.js";

const valid: PlaybookUpsert = {
  orgId: "00000000-0000-4000-8000-000000000001",
  agentInstanceId: "00000000-0000-4000-8000-000000000011",
  platform: "x",
  authorHandle: "builder",
  fsdProfileId: null,
  hookPatterns: ["Observed hook"],
  structureNotes: "Observed structure",
  cadenceNotes: "Observed cadence",
  topTopics: ["databases"],
  engagementPercentile: 0.5,
  samplePostIds: ["owned-source"],
  model: "inert",
};

describe("playbook admission bounds", () => {
  it.each([
    { samplePostIds: [] },
    { samplePostIds: Array(101).fill("same-source") },
    { samplePostIds: [""] },
    { samplePostIds: ["   "] },
    { samplePostIds: ["x".repeat(2049)] },
    { samplePostIds: [1] },
    { platform: "reddit" },
  ])("rejects invalid source/owner input before a database session %j", async (invalid) => {
    const query = vi.fn(async () => []);
    const sql = Object.assign(query, { json: (value: unknown) => value }) as unknown as Sql;
    await expect(upsertPlaybook(sql, { ...valid, ...invalid } as PlaybookUpsert)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});

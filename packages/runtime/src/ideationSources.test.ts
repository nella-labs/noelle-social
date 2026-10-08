import { describe, expect, it } from "vitest";
import { getRepliedPostSources } from "./ideationSources.js";

describe("getRepliedPostSources", () => {
  it("loads sent public reply/post pairs from saved Noelle data and dedupes by lead", async () => {
    const calls: string[] = [];
    const values: unknown[][] = [];
    const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      if (!strings.join(" ").includes("from noelle.approvals")) return { strings, values: vals };
      calls.push(strings.join(" "));
      values.push(vals);
      return Promise.resolve([
        {
          lead_id: "lead-1",
          url: "https://linkedin.com/feed/update/1",
          author: "alice",
          post: "The original post",
          reply: "The operator-approved reply",
          replied_at: "2026-09-14T10:00:00Z",
        },
        {
          lead_id: "lead-1",
          url: "https://linkedin.com/feed/update/1",
          author: "alice",
          post: "The original post",
          reply: "Duplicate reply",
          replied_at: "2026-09-14T09:00:00Z",
        },
        {
          lead_id: "lead-2",
          url: null,
          author: null,
          post: "  ",
          reply: "Blank post is dropped",
          replied_at: "2026-09-14T08:00:00Z",
        },
      ]);
    }) as never;

    const sources = await getRepliedPostSources(sql, {
      orgId: "org-1",
      platform: "linkedin",
      limit: 99,
    });

    expect(sources).toEqual([
      {
        leadId: "lead-1",
        url: "https://linkedin.com/feed/update/1",
        author: "alice",
        post: "The original post",
        reply: "The operator-approved reply",
        repliedAt: "2026-09-14T10:00:00Z",
      },
    ]);
    expect(calls[0]).toContain("a.status = 'sent'");
    expect(calls[0]).toContain("coalesce(d.payload->>'kind', 'reply') = 'reply'");
    expect(calls[0]).toContain("d.org_id =");
    expect(calls[0]).toContain("l.platform =");
    expect(values[0]).toContain("org-1");
    expect(values[0]).toContain("linkedin");
    expect(values[0]).toContain(40);
  });
});

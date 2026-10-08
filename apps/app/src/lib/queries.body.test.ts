import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ payload: {} as Record<string, unknown> }));
vi.mock("@/lib/auth-cookie", () => ({ getUserFromCookies: async () => ({ id: "user" }) }));
vi.mock("@/lib/db", () => {
  const readSql = async (strings: TemplateStringsArray) => {
    if (strings.join("").includes("from noelle.agent_instances")) return [{ id: "instance", org_id: "org" }];
    return [{
      approval_id: "approval", draft_id: "draft", lead_id: "lead", status: "pending",
      created_at: "2026-10-06T00:00:00Z", target_at: "2026-10-06T00:00:00Z",
      decided_at: null, decided_by: null, sent_external_id: null, posted_at: null,
      lead_author_handle: "ada", lead_author_id: null, lead_external_id: "123",
      wp_name: null, wp_headline: null,
      lead_payload: { author_handle: "ada", post_id: "123" }, draft_payload: state.payload,
    }];
  };
  return { readSql, sql: readSql, pgOrgMembersClient: () => async () => [{ user_id: "user" }] };
});

import {
  listAutoSendQueueForInstance, listRecentSentForInstance, listPersonInteractionsForOrg,
  listPendingLinkedInApprovals, listPendingRedditApprovals,
} from "./queries";

beforeEach(() => { state.payload = {}; });

const readers = [
  ["auto-send queue", async () => (await listAutoSendQueueForInstance("instance"))[0]?.bodyPreview],
  ["sent history", async () => (await listRecentSentForInstance("instance"))[0]?.bodyPreview],
  ["contact history", async () => (await listPersonInteractionsForOrg("org", "ada"))[0]?.body],
  ["LinkedIn inbox", async () => (await listPendingLinkedInApprovals("instance"))[0]?.body ?? null],
  ["Reddit inbox", async () => (await listPendingRedditApprovals("instance"))[0]?.body ?? null],
] as const;

test.each(readers)("%s does not revive an explicitly cleared edit", async (_name, read) => {
  state.payload = { kind: "reply", body: "Old text", edited_body: null };
  expect(await read()).toBeNull();
});

test.each(readers)("%s quotes a valid edit before a legacy bundle", async (_name, read) => {
  state.payload = { kind: "reply", angle: "technical", edited_body: "Confirmed edit", angles: { technical: { body: "Old bundle" } } };
  expect(await read()).toBe("Confirmed edit");
});

test.each(readers)("%s preserves an unedited selected bundle", async (_name, read) => {
  state.payload = { kind: "reply", angle: "technical", angles: { technical: { body: "Selected bundle" } } };
  expect(await read()).toBe("Selected bundle");
});

test.each([0, {}, [[]]])("invalid edit data is omitted by both platform inboxes: %j", async (edit) => {
  state.payload = { body: "Old text", edited_body: edit };
  expect(await listPendingLinkedInApprovals("instance")).toEqual([]);
  expect(await listPendingRedditApprovals("instance")).toEqual([]);
});

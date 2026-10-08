/**
 * A guard for splitting `queries.ts` (4,841 lines) into modules behind a
 * barrel. It pins two things the split can silently break: the export surface,
 * and which exports carry a tenancy gate.
 *
 * What it does NOT check, so nobody reads more into a green run than is there:
 * no export is ever invoked (`sql` is a `vi.fn()`), so bodies, signatures,
 * return shapes and SQL text are all out of scope. Values are pinned only for
 * the two exported constants below. The type-export map catches a REMOVED type
 * but not an added one — TypeScript cannot enumerate a namespace's types.
 */
import { describe, it, expect, vi } from "vitest";
import ts from "typescript";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Mock the SQL client + tenancy + supabase + auth-cookie before importing
// queries.ts. queries.ts uses module-level singletons, so we need to mock
// them at import time. (Same preamble as queries.spend.test.ts.)

vi.mock("@/lib/db", () => {
  return {
    sql: vi.fn(),
    pgOrgMembersClient: () => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { user_id: "user_1" },
                error: null,
              }),
            }),
          }),
        }),
      }),
    }),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user_1" } }, error: null }),
    },
  }),
}));

vi.mock("@/lib/auth-cookie", () => ({
  getUserFromCookies: async () => ({ id: "user_1", email: "user_1@example.com" }),
}));

vi.mock("@noelle/runtime", () => ({
  assertOrgMember: async () => {},
}));

// Importing AFTER the mocks so the module sees the fakes.
import * as queries from "./queries";

/**
 * Guard test: the export surface of `@/lib/queries`.
 *
 * queries.ts is the largest file in the repo (4,841 lines) and is about to be
 * split into modules behind a barrel. Dozens of dashboard pages and route
 * handlers import from it, and nothing else in the test suite checks that the
 * barrel still re-exports the WHOLE surface. A symbol dropped mid-split would
 * therefore stay silent until whichever page used it blew up in production.
 *
 * So pin the surface. This fails in both directions:
 *   - a REMOVED export  -> shows up in `missing`
 *   - an ADDED export   -> shows up in `unexpected`
 *
 * Adding or deleting a query is still perfectly fine. Update the list in the
 * same commit; the point is that the surface changes on purpose, never by
 * accident.
 */

/**
 * Every runtime (value) export, sorted. Derived from the file, not typed by
 * hand: the AST walk and `Object.keys(queries)` independently produce this
 * exact list.
 */
const EXPECTED_RUNTIME_EXPORTS: string[] = [
  "AUTOSEND_MAX_PER_30MIN_DEFAULT",
  "AUTOSEND_MAX_PER_DAY_DEFAULT",
  "addApifyConnection",
  "addApifyConnectionsBulk",
  "anyActiveXInternWorkerEnabled",
  "appendChatTurn",
  "clearApifyConnectionInvalid",
  "countActionedApprovalsForOrg",
  "countLinkedInWatchlistPeople",
  "countPatternRules",
  "countPendingApprovalsAcrossAgents",
  "countPendingApprovalsForOrg",
  "countPendingLinkedInApprovals",
  "countPendingRedditApprovals",
  "countRedditWatchlistSubreddits",
  "countSentApprovalsForOrg",
  "currentMonthIso",
  "dedupeApprovalsByLead",
  "deriveVegaWorkerStatus",
  "getAgentInstance",
  "getApifyProviderSpend",
  "getApifySpendByToken",
  "getApprovalDetail",
  "getAutoSendUsage",
  "getBusState",
  "getCapStatusForXIntern",
  "getCurrentUser",
  "getInstanceSpendThisMonth",
  "getLastSyncRun",
  "getLinkedInApprovalDetail",
  "getLinkedInInternInstance",
  "getLinkedInPipelineSnapshot",
  "getLinkedInProfileForOrg",
  "getLinkedInWatchlistPeopleForInstance",
  "getOrgBudgetCapCents",
  "getOrgBySlug",
  "getOrgSpendByBucketRange",
  "getOrgSpendBySourceMonth",
  "getOrgSpendByWorkerMonth",
  "getOrgSpendByWorkerRange",
  "getOrgSpendDaily14",
  "getOrgSpendDailyBySource",
  "getOrgSpendForMonth",
  "getOrgSpendTrendRange",
  "getPersonForOrg",
  "getPersonIdForHandle",
  "getPersonProfileForOrg",
  "getPersonStatsForOrg",
  "getPipelineSnapshot",
  "getRedditApprovalDetail",
  "getRedditInternInstance",
  "getRedditPipelineSnapshot",
  "getRedditWatchlistForInstance",
  "getSentDaily14ByAgent",
  "getSentStatsByAgent",
  "getWatchersForPerson",
  "getWatchlistForInstance",
  "getWatchlistPeopleForInstance",
  "getXAccount",
  "getXApiConnection",
  "isApifyBucket",
  "keepLatestLinkedInPostPerPerson",
  "keepLatestLinkedInPostRowsPerPerson",
  "keepLatestPostPerWatchlistedPerson",
  "listActiveWorkers",
  "listAgentInstancesForOrg",
  "listApifyConnectionSecrets",
  "listApifyConnections",
  "listAutoSendQueueForInstance",
  "listBusEvents",
  "listOrgsForCurrentUser",
  "listPatternRules",
  "listPendingApprovalsForOrg",
  "listPendingLinkedInApprovals",
  "listPendingRedditApprovals",
  "listPersonInteractionsForOrg",
  "listPersonsForOrg",
  "listRecentActivityForInstance",
  "listRecentSentForInstance",
  "listRecentWorkerRuns",
  "listVegaWorkerStatus",
  "listVisiblePatternAlerts",
  "loadChatTurnsForModel",
  "loadLatestChatConversation",
  "loadXApiSpend",
  "parseApifyTokens",
  "reconcileContactsForOrg",
  "removeApifyConnection",
  "resolveSpendRange",
  "rollUpPersonInteractions",
  "setApifyConnectionInUse",
];

/** Pinned separately so a wholesale list rewrite still trips the assertion. */
const EXPECTED_RUNTIME_EXPORT_COUNT = 91;

describe("@/lib/queries export surface", () => {
  it("exports exactly the pinned set of runtime symbols", () => {
    const actual = Object.keys(queries).sort();
    const missing = EXPECTED_RUNTIME_EXPORTS.filter((name) => !actual.includes(name));
    const unexpected = actual.filter((name) => !EXPECTED_RUNTIME_EXPORTS.includes(name));

    // Named up front so a failure reads as "you dropped X" / "you added Y"
    // instead of a 92-line array diff.
    expect({ missing, unexpected }).toEqual({ missing: [], unexpected: [] });
    expect(actual).toEqual(EXPECTED_RUNTIME_EXPORTS);
  });

  it("exports exactly 91 runtime symbols", () => {
    expect(new Set(EXPECTED_RUNTIME_EXPORTS).size).toBe(EXPECTED_RUNTIME_EXPORT_COUNT);
    expect(Object.keys(queries)).toHaveLength(EXPECTED_RUNTIME_EXPORT_COUNT);
  });

  // Names are the cheap half of the surface. These two constants are read as
  // VALUES by callers, so a split that re-declares one with a different literal
  // would pass every assertion above.

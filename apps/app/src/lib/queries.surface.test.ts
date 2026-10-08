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
  it("pins the value of the exported constants, not just their names", () => {
    expect(queries.AUTOSEND_MAX_PER_30MIN_DEFAULT).toBe(6);
    expect(queries.AUTOSEND_MAX_PER_DAY_DEFAULT).toBe(50);
  });
});

/**
 * The tenancy half of the guard, and the reason this file exists at all.
 *
 * Cloud SQL has no RLS (CLAUDE.md §5): every org-scoped read is safe only
 * because its body calls `assertMember(orgId, userId)`. Both that helper and
 * `requiredUserId` are module-PRIVATE `cache()` singletons, so splitting
 * queries.ts into modules behind a barrel has to relocate them — which is
 * exactly where a line gets dropped.
 *
 * A dropped gate is invisible to everything else here. The export surface stays
 * byte-identical, `tsc` is happy (this app sets neither `noUnusedLocals` nor
 * `noUnusedParameters`, so the orphaned `userId` local does not even warn), and
 * no test invokes the function. The failure mode is not a crash on the page
 * that used it — it is a silent cross-org read.
 *
 * So this asserts the exact SET of exports that gate. Losing one fails; gating
 * something new fails too, which is deliberate: it forces the list to be
 * re-read rather than grown by reflex.
 */
const GATED_BY_ASSERT_MEMBER: string[] = [
  "countActionedApprovalsForOrg",
  "countPatternRules",
  "countPendingApprovalsForOrg",
  "countSentApprovalsForOrg",
  "getAgentInstance",
  "getApifyProviderSpend",
  "getApifySpendByToken",
  "getApprovalDetail",
  "getBusState",
  "getCapStatusForXIntern",
  "getLinkedInApprovalDetail",
  "getLinkedInInternInstance",
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
  "getRedditApprovalDetail",
  "getRedditInternInstance",
  "getSentDaily14ByAgent",
  "getSentStatsByAgent",
  "listAgentInstancesForOrg",
  "listApifyConnections",
  "listBusEvents",
  "listPatternRules",
  "listPendingApprovalsForOrg",
  "listPersonsForOrg",
  "listVisiblePatternAlerts",
  "reconcileContactsForOrg",
];

/**
 * Every file the queries surface is implemented across: the module today, plus
 * `src/lib/queries/` once the split lands. Reading the directory rather than a
 * fixed path is what lets this same assertion survive the split it guards.
 */
function queriesSourceFiles(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [join(here, "queries.ts")].filter((p) => existsSync(p));
  const dir = join(here, "queries");
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".ts") && !name.endsWith(".test.ts")) files.push(join(dir, name));
    }
  }
  return files;
}

/** Direct membership calls and the verified local pattern scope helper keep the same public gate authority. */
function calls(node: ts.Node, name: string): boolean {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === name
  ) return true;
  return ts.forEachChild(node, (child) => calls(child, name)) === true;
}
function exportsThatGate(): string[] {
  const found = new Set<string>();
  for (const file of queriesSourceFiles()) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const scope = sf.statements.find(
      (st) => ts.isFunctionDeclaration(st) && st.name?.text === "authorizedPatternScope",
    );
    const scopeGates =
      scope && ts.isFunctionDeclaration(scope) && scope.body && calls(scope.body, "assertMember");
    const gates = (body: ts.Node) =>
      calls(body, "assertMember") || (scopeGates && calls(body, "authorizedPatternScope"));
    for (const st of sf.statements) {
      // Narrow to a Declaration BEFORE asking for modifier flags —
      // getCombinedModifierFlags takes a Declaration, not a Statement. For a
      // variable it is asked of the declaration, which is what "combined" is
      // for: it walks up to the `export` on the enclosing statement.
      if (ts.isFunctionDeclaration(st)) {
        if (!(ts.getCombinedModifierFlags(st) & ts.ModifierFlags.Export)) continue;
        if (st.name && st.body && gates(st.body)) {
          found.add(st.name.text);
        }
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!(ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Export)) continue;
          if (!ts.isIdentifier(d.name) || !d.initializer) continue;
          if (gates(d.initializer)) found.add(d.name.text);
        }
      }
    }
  }
  return [...found].sort();
}

describe("@/lib/queries tenancy gates", () => {
  it("finds source to scan at all", () => {
    // Guard the guard: if the file layout moves and the scan silently finds
    // nothing, every assertion below would pass on an empty set.
    const files = queriesSourceFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(exportsThatGate().length).toBeGreaterThan(0);
  });

  it("gates exactly the pinned set of org-scoped exports", () => {
    const actual = exportsThatGate();
    const ungated = GATED_BY_ASSERT_MEMBER.filter((n) => !actual.includes(n));
    const newlyGated = actual.filter((n) => !GATED_BY_ASSERT_MEMBER.includes(n));
    // `ungated` is the dangerous direction: an org-scoped read that lost its
    // membership check. Named first so the failure says which one.
    expect({ ungated, newlyGated }).toEqual({ ungated: [], newlyGated: [] });
  });

  it("keeps every gated export in the public surface", () => {
    // A gate on a function nobody can call is not protection, it is dead code —
    // and it would mean the split moved a body but lost its export.
    for (const name of GATED_BY_ASSERT_MEMBER) {
      expect(EXPECTED_RUNTIME_EXPORTS, `${name} gates but is not exported`).toContain(name);
    }
  });
});

/**
 * The other half of the surface: 59 type-only exports (51 interfaces,
 * 8 aliases). These are erased before runtime, so `Object.keys` above is blind
 * to them — naming each one here is what pins them, and `tsc --noEmit` is what
 * enforces it (apps/app/tsconfig.json globs every .ts under the app, test
 * files included). Drop one in the split and this file stops compiling with
 * "Namespace 'queries' has no exported member".
 */
type _PinnedTypeExports = {
  AgentActivityEvent: queries.AgentActivityEvent;
  ApifyBulkAddResult: queries.ApifyBulkAddResult;
  ApifyConnection: queries.ApifyConnection;
  ApifyConnectionSecret: queries.ApifyConnectionSecret;
  ApifyTokenSpend: queries.ApifyTokenSpend;
  ApprovalDetail: queries.ApprovalDetail;
  ApprovalSort: queries.ApprovalSort;
  ApprovalSourceFilter: queries.ApprovalSourceFilter;
  ApprovalStatusFilter: queries.ApprovalStatusFilter;
  ApprovalWatchlistFilter: queries.ApprovalWatchlistFilter;
  AutoSendQueueRow: queries.AutoSendQueueRow;
  AutoSendUsage: queries.AutoSendUsage;
  ChatConversation: queries.ChatConversation;
  ChatHistoryMessage: queries.ChatHistoryMessage;
  DashboardBusEvent: queries.DashboardBusEvent;
  DashboardBusStateEntry: queries.DashboardBusStateEntry;
  HandleInteractionStats: queries.HandleInteractionStats;
  InstanceTargeting: queries.InstanceTargeting;
  LinkedInApprovalDetail: queries.LinkedInApprovalDetail;
  LinkedInApprovalView: queries.LinkedInApprovalView;
  LinkedInWatchlistPersonRow: queries.LinkedInWatchlistPersonRow;
  ListPendingApprovalsOptions: queries.ListPendingApprovalsOptions;
  ListPendingLinkedInApprovalsOptions: queries.ListPendingLinkedInApprovalsOptions;
  ListPendingRedditApprovalsOptions: queries.ListPendingRedditApprovalsOptions;
  OrgSpendBySource: queries.OrgSpendBySource;
  PatternAlertRow: queries.PatternAlertRow;
  PatternRuleRow: queries.PatternRuleRow;
  PendingApprovalRow: queries.PendingApprovalRow;
  PersonDetail: queries.PersonDetail;
  PersonInteraction: queries.PersonInteraction;
  PersonListItem: queries.PersonListItem;
  PersonRollup: queries.PersonRollup;
  PersonSocialAccountView: queries.PersonSocialAccountView;
  PersonStats: queries.PersonStats;
  PersonWatcher: queries.PersonWatcher;
  PipelineScheduleSnapshot: queries.PipelineScheduleSnapshot;
  PipelineSnapshot: queries.PipelineSnapshot;
  PipelineWorkerSnapshot: queries.PipelineWorkerSnapshot;
  RedditApprovalDetail: queries.RedditApprovalDetail;
  RedditApprovalView: queries.RedditApprovalView;
  RedditWatchlistRow: queries.RedditWatchlistRow;
  SentApprovalRow: queries.SentApprovalRow;

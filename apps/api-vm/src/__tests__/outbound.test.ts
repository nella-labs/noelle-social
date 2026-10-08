import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createApp } from "../app.js";
import { resetEnvForTests } from "../env.js";
import { signHmacBody } from "../middleware/hmac.js";
import {
  __setDbClientForTests,
  resetDbClientForTests,
} from "../lib/db.js";
import type { OutboundIn } from "@noelle/contracts";
import { draftPushoverTitle, shouldNotifyBatch, sanitizeForJsonb } from "../routes/outbound.js";

const HMAC_SECRET = "y".repeat(48);

beforeAll(() => {
  process.env.PORT = "18791";
  process.env.NODE_ENV = "test";
  // Required by Zod, never dialled — tests inject the db client via
  // __setDbClientForTests so loadEnv() doesn't need a real Cloud SQL URL.
  process.env.NOELLE_DATABASE_URL =
    "postgres://noelle_app:test@127.0.0.1:5432/noelle?sslmode=require";
  process.env.NOELLE_SUPABASE_JWT_SECRET = "test-jwt-secret";
  process.env.NOELLE_HMAC_SECRET = HMAC_SECRET;
  delete process.env.NOELLE_APP_BASE_URL;
  delete process.env.NOELLE_SUPABASE_URL;
  delete process.env.NOELLE_SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.OPENCLAW_SUPABASE_URL;
  delete process.env.OPENCLAW_SUPABASE_SERVICE_ROLE_KEY;
  resetEnvForTests();
});

// ---------------------------------------------------------------------------
// In-memory postgres.js stub. We only need to satisfy the shapes the routes
// actually use:
//
//   - sql`select ... from noelle.agent_instances where role = ${...} ...`
//   - sql`insert into noelle.leads (...) values (${...}) on conflict ...`
//   - sql`insert into noelle.drafts ${sql([...], "id", "lead_id", ...)} on conflict (id) do nothing`
//   - sql`insert into noelle.approvals ${sql([...], ...)} on conflict (draft_id) do update ... returning ...`
//   - sql.json(obj)  → marker that wraps an object for jsonb encoding
//   - sql(rows, ...cols) → marker that expands into a multi-row VALUES list
//
// Approach: classify each template invocation by its leading keyword (select,
// insert, update) and table name, then operate on a hand-rolled rows store.
// This avoids pulling in pg-mem (which doesn't model postgres.js's helper
// markers anyway) and keeps the regression surface tied to the SQL we actually
// ship.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type TableState = {
  rows: Row[];
  // When set, the next op against this table throws this message.
  error?: string | null;
  // Column the test wants conflict resolution to dedupe by.
  conflictKey?: string;
};

let __idCounter = 0;
function genId() {
  __idCounter += 1;
  return `00000000-0000-4000-8000-${String(__idCounter).padStart(12, "0")}`;
}

// Marker for sql.json() and sql(rows, cols) helpers. The stub recognises
// these by `__kind` so the template builder doesn't have to inspect class
// identity (postgres.js's real markers are non-public classes).
type JsonMarker = { __kind: "json"; value: unknown };
type RowsMarker = {
  __kind: "rows";
  rows: ReadonlyArray<Row>;
  cols: ReadonlyArray<string>;
};
type ListMarker = { __kind: "list"; values: readonly unknown[] };

function isJsonMarker(v: unknown): v is JsonMarker {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { __kind?: string }).__kind === "json"
  );
}

function isRowsMarker(v: unknown): v is RowsMarker {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { __kind?: string }).__kind === "rows"
  );
}

// Pulls the first matching table name from a SQL fragment. The routes only
// ever target noelle.<table>, so this is a tight match.
function tableFromSql(sqlText: string): string | undefined {
  const m = sqlText.match(/noelle\.([a-z_]+)/i);
  return m?.[1];
}

function classify(sqlText: string): "select" | "insert" | "update" | "other" {
  const trimmed = sqlText.trim().toLowerCase();
  if (trimmed.startsWith("select") || trimmed.startsWith("\nselect")) return "select";
  if (trimmed.startsWith("insert") || trimmed.startsWith("\ninsert")) return "insert";
  if (trimmed.startsWith("update") || trimmed.startsWith("\nupdate")) return "update";
  if (/^\s*select/i.test(trimmed)) return "select";
  if (/^\s*insert/i.test(trimmed)) return "insert";
  if (/^\s*update/i.test(trimmed)) return "update";
  return "other";
}

function makeFakeDb(initial: Record<string, TableState>) {
  const state: Record<string, TableState> = { ...initial };

  function getTable(name: string): TableState {
    return state[name] ?? (state[name] = { rows: [], error: null });
  }

  // Core tagged-template entry point. Builds the final SQL text by
  // interleaving the static strings with placeholder markers for each
  // dynamic value, then dispatches on classify()+tableFromSql().
  function tag(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Row[]> & Row[] {
    let text = "";
    for (let i = 0; i < strings.length; i++) {
      text += strings[i];
      if (i < values.length) text += `<<v${i}>>`;
    }

    const op = classify(text);
    const table = tableFromSql(text);
    const t = table ? getTable(table) : undefined;

    if (t?.error) {
      // postgres.js throws on errors rather than returning {error}. The
      // routes catch and surface the .message; mirror that.
      return Promise.reject(new Error(t.error)) as unknown as Promise<Row[]> &
        Row[];
    }

    let result: Row[] = [];

    if (op === "select" && t) {
      // Crude equality filter extraction: pull `<col> = <<vN>>` pairs.
      const filters: Array<[string, unknown]> = [];
      const nullableGuardedPlaceholders = new Set<number>();
      const nullableGuardRe =
        /\(<<v(\d+)>>::uuid\s+is\s+null\s+or\s+([a-z_]+)\s*=\s*<<v(\d+)>>\)/gi;
      let gm: RegExpExecArray | null;
      while ((gm = nullableGuardRe.exec(text)) !== null) {
        const guardIdx = Number(gm[1]);
        const col = gm[2]!;
        const valueIdx = Number(gm[3]);
        nullableGuardedPlaceholders.add(valueIdx);
        if (values[guardIdx] !== null && values[guardIdx] !== undefined) {
          filters.push([col, values[valueIdx]]);
        }
      }
      const re = /([a-z_]+)\s*=\s*<<v(\d+)>>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const col = m[1]!;
        const idx = Number(m[2]);
        if (nullableGuardedPlaceholders.has(idx)) continue;
        filters.push([col, values[idx]]);
      }
      // Some filters are literal strings (e.g. role = 'x_intern'); pull those too.
      const literalRe = /([a-z_]+)\s*=\s*'([^']+)'/gi;
      // ORDER BY (status = 'active') prioritizes active rows; it does not filter paused rows.
      const predicateText = text.split(/\border by\b/i)[0]!;
      while ((m = literalRe.exec(predicateText)) !== null) {
        filters.push([m[1]!, m[2]!]);
      }
      result = t.rows.filter((r) =>
        filters.every(([c, v]) => (r as Row)[c] === v)
      );
      const listFilter = text.match(/([a-z_]+)\s+in\s+<<v(\d+)>>/i);
      if (listFilter) {
        const marker = values[Number(listFilter[2])] as ListMarker;
        result = result.filter(r => marker.values.includes(r[listFilter[1]!]));
      }
      if (/count\(\*\)/i.test(text)) {
        result = [{ count: String(result.length) }];
      }
    } else if (op === "insert" && t) {
      // Look for the rows-marker placeholder (multi-row inserts) or a
      // simple values list (single row insert with column ordering in the
      // INSERT ... (col, col, ...) VALUES (<<v0>>, <<v1>>, ...) shape).
      const rowsMarkerIdx = values.findIndex(isRowsMarker);
      let toInsert: Row[] = [];

      if (rowsMarkerIdx >= 0) {
        const marker = values[rowsMarkerIdx] as RowsMarker;
        toInsert = marker.rows.map((r) => {
          const out: Row = {};
          for (const c of marker.cols) {
            const v = (r as Row)[c];
            out[c] = isJsonMarker(v) ? (v as JsonMarker).value : v;
          }
          return out;
        });
      } else {
        // Single-row insert. Parse the column list and the VALUES list.
        const colMatch = text.match(
          /insert\s+into\s+noelle\.[a-z_]+\s*\(([^)]+)\)/i
        );
        const valMatch = text.match(/values\s*\(([^)]+)\)/i);
        if (colMatch && valMatch) {
          const cols = colMatch[1]!.split(",").map((s) => s.trim());
          const valTokens = valMatch[1]!.split(",").map((s) => s.trim());
          const row: Row = {};
          for (let i = 0; i < cols.length; i++) {
            const tok = valTokens[i] ?? "";
            const ph = tok.match(/<<v(\d+)>>/);
            if (ph) {
              const v = values[Number(ph[1])];
              row[cols[i]!] = isJsonMarker(v)
                ? (v as JsonMarker).value
                : v;
            }
          }
          toInsert = [row];
        }
      }

      // Conflict resolution: parse `on conflict (<cols>)`. `do nothing`
      // skips duplicates; `do update` patches existing rows.
      const conflictMatch = text.match(/on\s+conflict\s*\(([^)]+)\)/i);
      const conflictCols = conflictMatch?.[1]?.split(",").map((col) => col.trim()) ?? [];
      const doNothing = /do\s+nothing/i.test(text);

      const stored: Row[] = [];
      for (const row of toInsert) {
        let idx = -1;
        if (conflictCols.length && conflictCols.every((col) => (row as Row)[col] !== undefined)) {
          idx = t.rows.findIndex(
            (r) => conflictCols.every((col) => (r as Row)[col] === (row as Row)[col])
          );
        }
        if (idx >= 0) {
          if (!doNothing) {
            // do update — patch the existing row with the new values. Model a
            // jsonb merge (`set payload = noelle.leads.payload || excluded.payload`)
            // when the SQL asks for it, so a merge upsert keeps the keys the
            // incoming row omits instead of clobbering the whole column.
            const merged: Row = { ...t.rows[idx], ...row };
            if (/payload\s*\|\|\s*(?:excluded\.payload|case)/i.test(text)) {
              const incoming = { ...(((row as Row).payload as Record<string, unknown>) ?? {}) };
              if (/excluded\.payload\s*-\s*'posted_at'/i.test(text) && incoming.posted_at == null) {
                delete incoming.posted_at;
              }
              merged.payload = {
                ...((t.rows[idx] as Row).payload as Record<string, unknown>),
                ...incoming,
              };
            }
            t.rows[idx] = merged;
          }
          stored.push(t.rows[idx]!);
        } else {
          const withId: Row = { ...row };
          if (!("id" in withId) || withId.id === undefined) {
            withId.id = genId();
          }
          if (!("created_at" in withId)) {
            withId.created_at = new Date().toISOString();
          }
          t.rows.push(withId);
          stored.push(withId);
        }
      }

      if (/returning/i.test(text)) {
        result = stored;
      } else {
        result = [];
      }
    } else if (op === "update" && t) {
      // `update noelle.X set <patch> where id = <<vN>>` is the shape we
      // care about. Pull the where clause's column + placeholder, find
      // matching rows, then apply each `set <col> = <<vM>>` pair.
      const whereMatch = text.match(/where\s+([a-z_]+)\s*=\s*<<v(\d+)>>/i);
      if (whereMatch) {
        const col = whereMatch[1]!;
        const val = values[Number(whereMatch[2])];
        // Pull `set col = <<vN>>` pairs (anything before WHERE).
        const setBlock = text.slice(
          text.toLowerCase().indexOf("set ") + 4,
          text.toLowerCase().indexOf("where")
        );
        const setRe = /([a-z_]+)\s*=\s*<<v(\d+)>>/gi;
        const setters: Array<[string, unknown]> = [];
        let sm: RegExpExecArray | null;
        while ((sm = setRe.exec(setBlock)) !== null) {
          const c = sm[1]!;
          const v = values[Number(sm[2])];
          setters.push([c, isJsonMarker(v) ? (v as JsonMarker).value : v]);
        }
        for (const r of t.rows) {
          if ((r as Row)[col] === val) {
            for (const [c, v] of setters) (r as Row)[c] = v;
          }
        }
      }
      result = [];
    }

    // Routes always `await sql\`...\`` before indexing, so a plain Promise
    // is enough. (Real postgres.js returns a thenable RowList; we don't
    // need that complexity in the stub.)
    return Promise.resolve(result) as Promise<Row[]> & Row[];
  }

  // Helper used by sql.unsafe(query, params) — fixed parametrised SQL with
  // $1, $2 placeholders. Used by the tenancy guard's QueryExecutor adapter.
  function unsafe(query: string, params: unknown[]): Promise<Row[]> {
    // Substitute $N with placeholder markers compatible with the tag parser.
    const text = query.replace(/\$(\d+)/g, (_, n) => `<<v${Number(n) - 1}>>`);
    // Wrap into the same tag-style dispatch.
    const arr: string[] = [text];
    const withRaw: unknown = Object.assign(arr, {
      raw: [text] as readonly string[],
    });
    const fakeStrings = withRaw as TemplateStringsArray;
    return tag(fakeStrings, ...params) as unknown as Promise<Row[]>;
  }

  // sql.json(obj) marker — wraps an object so the stub knows to store it
  // verbatim (no string conversion).
  function json(value: unknown): JsonMarker {
    return { __kind: "json", value };
  }

  // sql(rowsArray, ...cols) — marks a multi-row VALUES insertion. Real
  // postgres.js returns an opaque marker that the template interpolator
  // expands; the stub stashes the rows + cols.
  function rowsHelper(
    rows: ReadonlyArray<Row>,
    ...cols: string[]
  ): RowsMarker | ListMarker {
    if (!cols.length) return { __kind: "list", values: rows };
    return { __kind: "rows", rows, cols };
  }

  // Assemble the callable: postgres.js's `sql` is both a tag and a function.
  const sql = Object.assign((...args: unknown[]) => {
    // Tagged-template call: first arg is a TemplateStringsArray.
    if (Array.isArray(args[0]) && "raw" in (args[0] as object)) {
      return tag(args[0] as unknown as TemplateStringsArray, ...args.slice(1));
    }
    // sql(rowsArray, ...cols)
    if (Array.isArray(args[0])) {
      return rowsHelper(args[0] as Row[], ...(args.slice(1) as string[]));
    }
    throw new Error("unexpected sql() call shape in test stub");
  }, {
    json,
    unsafe,
    async begin(callback: (tx: Sql) => Promise<unknown>): Promise<unknown> {
      const snapshot = structuredClone(state);
      try { return await callback(sql as unknown as Sql); }
      catch (error) {
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, snapshot);
        throw error;
      }
    },
    __state: state,
  });
  return sql as unknown as Sql & { __state: Record<string, TableState> };
}

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const INSTANCE_ID = "00000000-0000-4000-8000-000000000002";
const LEAD_EXTERNAL_ID = "ext-lead-001";
const DRAFT_ID_E = "00000000-0000-4000-8000-000000000010";
const DRAFT_ID_T = "00000000-0000-4000-8000-000000000011";
const DRAFT_ID_C = "00000000-0000-4000-8000-000000000012";

function basePayload(): OutboundIn {
  return {
    leadId: LEAD_EXTERNAL_ID,
    batchNumber: 12,
    platform: "x",
    authorHandle: "danabra_mov",
    authorId: "12345",
    authorFollowers: 42000,
    allowsDms: true,
    originalPostId: "1976543210987654321",
    originalPostText: "shipping daily is the only thing that matters",
    originalPostUrl: "https://x.com/danabra_mov/status/1976543210987654321",
    postedAt: "2026-05-17T18:00:00.000Z",
    matchedTrigger: "agent",
    drafts: [
      { id: DRAFT_ID_E, kind: "reply", angle: "empathetic", body: "ok", charCount: 2 },
      { id: DRAFT_ID_T, kind: "reply", angle: "technical", body: "ok", charCount: 2 },
      { id: DRAFT_ID_C, kind: "reply", angle: "contrarian", body: "ok", charCount: 2 },
    ],
    qualityScore: 0.82,
    qualityGatePassed: true,
    tier: "T1",
    postKind: "opinion",
    verifierMeta: {
      pass: true,
      scores: { voice: 0.9, grounding: 0.9, relevance: 0.9, format: 1 },
      attempts: 0,
      reasons: [],
      judgeOk: true,
      judgeProvider: "jev",
    },
  };
}

function relationshipPayload(overrides: Partial<OutboundIn> = {}): OutboundIn {
  return {
    ...basePayload(),
    postKind: "relationship_dm",
    drafts: [
      {
        id: "relationship-draft-1",
        kind: "dm",
        angle: null,
        body: "Saw your saved notes and wanted to say hi.",
        charCount: 42,
      },
    ],
    ...overrides,
  };
}

async function postOutbound(app: ReturnType<typeof createApp>, payload: OutboundIn) {
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const { signature } = signHmacBody(HMAC_SECRET, ts, body);
  return app.request("/api/outbound", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-noelle-timestamp": String(ts),
      "x-noelle-signature": signature,
    },
  });
}

beforeEach(() => {
  resetDbClientForTests();
});

describe("outbound notification receipts", () => {
  type NotificationReceipt = {
    approval_ids: string[];
    approval_id: string;
    pushover_fired: boolean;
  };

  beforeEach(() => {
    vi.stubEnv("PUSHOVER_USER_KEY", "synthetic-global-user");
    vi.stubEnv("PUSHOVER_APP_TOKEN", "synthetic-global-token");
    vi.stubEnv("NOELLE_APP_BASE_URL", "https://console.invalid");
    vi.stubEnv("NOELLE_NOTIFY_BATCH", "1");
    resetEnvForTests();
    __setDbClientForTests(makeFakeDb({
      agent_instances: { rows: [{ id: INSTANCE_ID, org_id: ORG_ID, role: "x_intern", status: "active" }] },
      leads: { rows: [] }, drafts: { rows: [] }, approvals: { rows: [] },
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  it.each([
    { receipt: '{"status":0}', fired: false },
    { receipt: '{"status":1,"request":"accepted"}', fired: true },
  ])("reports provider acceptance $fired after saving the bundle", async ({ receipt, fired }) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(receipt));
    vi.stubGlobal("fetch", fetchImpl);
    const response = await postOutbound(createApp(), basePayload());
    expect(response.status).toBe(200);
    const body = await response.json() as NotificationReceipt;
    expect(body.approval_ids).toHaveLength(3);
    expect(body.pushover_fired).toBe(fired);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const notification = new URLSearchParams(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(notification.get("user")).toBe("synthetic-global-user");
    expect(notification.get("url")).toBe(`https://console.invalid/approvals/${body.approval_id}`);
    expect(notification.get("url_title")).toBe("Review in Noelle");
  });

  it.each(["quality", "batch", "url"])("keeps the %s notification gate", async (gate) => {
    const payload = basePayload();
    if (gate === "quality") payload.qualityGatePassed = false;
    if (gate === "batch") vi.stubEnv("NOELLE_NOTIFY_BATCH", "1000000");
    if (gate === "url") vi.stubEnv("NOELLE_APP_BASE_URL", undefined);
    resetEnvForTests();
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);
    const response = await postOutbound(createApp(), payload);
    expect(response.status).toBe(200);
    const body = await response.json() as NotificationReceipt;
    expect(body.approval_ids).toHaveLength(3);
    expect(body.pushover_fired).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("DM writing review attribution", () => {
  it.each([true, false])("keeps reply verdicts off DMs (DM check present: %s)", async (withDmCheck) => {
    const db = makeFakeDb({
      agent_instances: { rows: [{ id: INSTANCE_ID, org_id: ORG_ID, role: "x_intern", status: "active" }] },
      leads: { rows: [] }, drafts: { rows: [] }, approvals: { rows: [] },
    });
    __setDbClientForTests(db);
    const payload = basePayload();
    const verifierMeta = {
      pass: true, scores: { voice: 0.9, grounding: 0.9, relevance: 0.9, format: 1 },
      attempts: 0, reasons: [],
    };
    const dmVoiceCheck = { pass: true, attempts: 1, reasons: [] };
    payload.verifierMeta = verifierMeta;
    payload.drafts.push({
      id: "dm-review-1", kind: "dm", angle: null, body: "hey, that demo deserved the win", charCount: 30,
      ...(withDmCheck ? { dmVoiceCheck } : {}),
    });
    expect((await postOutbound(createApp(), payload)).status).toBe(200);
    const rows = db.__state.drafts!.rows;
    const dm = rows.find((row) => (row.payload as Row).kind === "dm")!.payload as Row;
    const reply = rows.find((row) => (row.payload as Row).kind === "reply")!.payload as Row;
    expect(reply.verifier_meta).toEqual(verifierMeta);
    expect(dm.verifier_meta).toBeUndefined();
    expect(dm.dm_voice_check).toEqual(withDmCheck ? dmVoiceCheck : undefined);
  });

  it("persists each reply angle's own verdict instead of copying a failed set verdict", async () => {
    const db = makeFakeDb({
      agent_instances: { rows: [{ id: INSTANCE_ID, org_id: ORG_ID, role: "x_intern", status: "active" }] },
      leads: { rows: [] }, drafts: { rows: [] }, approvals: { rows: [] },
    });
    __setDbClientForTests(db);
    const payload = basePayload();
    payload.verifierMeta = {
      pass: false, scores: { voice: 0.5, grounding: 0.9, relevance: 0.9, format: 1 },
      attempts: 2, reasons: ["one angle failed"], judgeOk: true, judgeProvider: "legacy",
    };
    const passing = {
      pass: true, scores: { voice: 0.93, grounding: 0.95, relevance: 0.94, format: 1 },
      attempts: 0, reasons: [], judgeOk: true, judgeProvider: "jev" as const,
    };
    Object.assign(payload.drafts[0]!, { verifierMeta: passing });
    expect((await postOutbound(createApp(), payload)).status).toBe(200);
    expect((db.__state.drafts!.rows[0]!.payload as Row).verifier_meta).toEqual(passing);
  });
});

describe("draftPushoverTitle", () => {
  it("labels a LinkedIn (Lyra) draft as the LinkedIn Intern, not the X Intern", () => {
    const title = draftPushoverTitle({ platform: "linkedin", tierLabel: "T2", authorHandle: "kaia-tham" });
    expect(title).toBe("🤖 LinkedIn Intern: T2 draft from @kaia-tham");
    expect(title).not.toContain("X Intern");
  });

  it("labels an X (Vega) draft as the X Intern", () => {
    expect(draftPushoverTitle({ platform: "x", tierLabel: "T1", authorHandle: "elonmusk" })).toBe(
      "🤖 X Intern: T1 draft from @elonmusk",
    );
  });

  it("labels a Reddit draft as the Reddit Intern", () => {
    expect(draftPushoverTitle({ platform: "reddit", tierLabel: "T?", authorHandle: "u_foo" })).toBe(
      "🤖 Reddit Intern: T? draft from @u_foo",
    );
  });
});

describe("sanitizeForJsonb", () => {
  it("strips a lone high surrogate (emoji split by a snippet slice) that breaks jsonb", () => {
    // "\uD83D" alone is the front half of 😀 — Postgres jsonb rejects it with
    // "invalid input syntax for type json".
    expect(sanitizeForJsonb({ snippet: "great post \uD83D" }).snippet).toBe("great post ");
  });
  it("strips a lone low surrogate", () => {
    expect(sanitizeForJsonb({ s: "\uDE00 trailing" }).s).toBe(" trailing");
  });
  it("keeps a valid surrogate pair (full emoji) intact", () => {
    expect(sanitizeForJsonb({ s: "ship it 😀🔥" }).s).toBe("ship it 😀🔥");
  });
  it("strips NUL bytes", () => {
    expect(sanitizeForJsonb({ s: "a" + String.fromCharCode(0) + "b" }).s).toBe("ab");
  });
  it("recurses into nested arrays/objects (the anchors + drafts payload)", () => {
    const out = sanitizeForJsonb({
      anchors: [{ snippet: "x \uD83D", score: 4.2 }],
      drafts: [{ body: "ok \uDC00", char_count: 3 }],
    });
    expect(out.anchors[0]!.snippet).toBe("x ");
    expect(out.anchors[0]!.score).toBe(4.2);
    expect(out.drafts[0]!.body).toBe("ok ");
    expect(out.drafts[0]!.char_count).toBe(3);
  });
  it("leaves clean strings, numbers, null, and booleans untouched", () => {
    const o = { a: "hi", n: 5, z: null, b: true };
    expect(sanitizeForJsonb(o)).toEqual(o);
  });
});

describe("outbound saved factual evidence", () => {
  const context = { version: 1, platform: "x", postText: "Original selected source", knowledgeAnchors: ["Oriole maps Atlas"] };
  it("stores the supplied factual context on the exact draft", async () => {
    const db = makeFakeDb({ agent_instances: { rows: [{ id: INSTANCE_ID, org_id: ORG_ID, role: "x_intern", status: "active" }] },
      leads: { rows: [] }, drafts: { rows: [] }, approvals: { rows: [] } });
    __setDbClientForTests(db);
    const input = basePayload();
    Object.assign(input.drafts[0]!, { reviewContext: context });
    expect((await postOutbound(createApp(), input)).status).toBe(200);
    expect(db.__state.drafts!.rows[0]!.payload).toMatchObject({ body: "ok", review_context: context });
  });
  it("rejects changed factual evidence on a reused draft without enriching the lead", async () => {
    const db = makeFakeDb({ agent_instances: { rows: [{ id: INSTANCE_ID, org_id: ORG_ID, role: "x_intern", status: "active" }] },
      leads: { rows: [] }, drafts: { rows: [] }, approvals: { rows: [] } });
    __setDbClientForTests(db);
    const input = basePayload();
    Object.assign(input.drafts[0]!, { reviewContext: context });
    expect((await postOutbound(createApp(), input)).status).toBe(200);
    const before = structuredClone(db.__state);
    const changed = structuredClone(input);
    changed.originalPostText = "Later lead enrichment";
    Object.assign(changed.drafts[0]!, { reviewContext: { ...context, knowledgeAnchors: [] } });
    expect((await postOutbound(createApp(), changed)).status).toBe(409);
    expect(db.__state).toEqual(before);
  });
});

describe("shouldNotifyBatch", () => {
  it("batch size 1 (default) notifies on every bundle — back-compat", () => {
    expect(shouldNotifyBatch(1, 1)).toBe(true);
    expect(shouldNotifyBatch(7, 1)).toBe(true);
  });
  it("batch size 10 notifies only on every 10th bundle", () => {
    for (const n of [1, 2, 9, 11, 19]) expect(shouldNotifyBatch(n, 10)).toBe(false);
    for (const n of [10, 20, 30]) expect(shouldNotifyBatch(n, 10)).toBe(true);
  });
  it("treats a non-positive batch size as 'every bundle'", () => {
    expect(shouldNotifyBatch(3, 0)).toBe(true);
  });
});

describe("POST /api/outbound", () => {
  it("upserts lead+drafts+approvals and returns the empathetic approval id", async () => {
    const db = makeFakeDb({
      agent_instances: {
        rows: [
          { id: INSTANCE_ID, org_id: ORG_ID, role: "x_intern", status: "active" },
        ],
        error: null,
      },
      leads: { rows: [], error: null },
      drafts: { rows: [], error: null },
      approvals: { rows: [], error: null },
    });
    __setDbClientForTests(db);

    const app = createApp();
    const body = JSON.stringify(basePayload());
    const ts = Math.floor(Date.now() / 1000);
    const { signature } = signHmacBody(HMAC_SECRET, ts, body);

    const res = await app.request("/api/outbound", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-noelle-timestamp": String(ts),
        "x-noelle-signature": signature,
      },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      approval_id: string;
      approval_ids: string[];
      draft_ids: string[];
      lead_id: string;
      pushover_fired: boolean;
    };
    expect(json.approval_ids).toHaveLength(3);
    expect(json.draft_ids).toEqual(
      expect.arrayContaining([DRAFT_ID_E, DRAFT_ID_T, DRAFT_ID_C])
    );
    expect(json.lead_id).toBeDefined();
    // No NOELLE_APP_BASE_URL set in this test → Pushover skipped.
    expect(json.pushover_fired).toBe(false);

    // The lead was upserted by external_id.
    const fakeState = (db as unknown as { __state: Record<string, TableState> })
      .__state;
    const leadRows = fakeState.leads!.rows;
    expect(leadRows).toHaveLength(1);
    expect(leadRows[0]!.external_id).toBe(LEAD_EXTERNAL_ID);
    expect(leadRows[0]!.org_id).toBe(ORG_ID);

    // 3 drafts persisted with drafter-supplied ids.
    const draftRows = fakeState.drafts!.rows;
    expect(draftRows.map((r) => r.id).sort()).toEqual(
      [DRAFT_ID_E, DRAFT_ID_T, DRAFT_ID_C].sort()
    );

    // All variants remain auditable, but only the first passing reply is actor-ready.
    const approvalRows = fakeState.approvals!.rows;
    expect(approvalRows).toHaveLength(3);
    expect(approvalRows[0]).toMatchObject({ status: "pending", decided_at: null });
    expect(approvalRows.slice(1).every((r) =>
      r.status === "skipped"
      && r.decided_by === "automatic-review"
      && r.skip_reason === "automatic-review-sibling"
      && typeof r.decided_at === "string"
    )).toBe(true);
  });

  it("uses an explicit owner to select the correct same-platform active instance", async () => {
    const otherOrg = "00000000-0000-4000-8000-000000000101";
    const otherInstance = "00000000-0000-4000-8000-000000000102";
    const db = makeFakeDb({
      agent_instances: {
        rows: [
          { id: INSTANCE_ID, org_id: ORG_ID, role: "x_intern", status: "active" },
          { id: otherInstance, org_id: otherOrg, role: "x_intern", status: "active" },
        ],
        error: null,
      },
      leads: { rows: [], error: null },
      drafts: { rows: [], error: null },
      approvals: { rows: [], error: null },
    });
    __setDbClientForTests(db);

    const res = await postOutbound(createApp(), {
      ...basePayload(),
      owner: { orgId: otherOrg, agentInstanceId: otherInstance },
      leadId: "owned-lead-1",
    });
    expect(res.status).toBe(200);

    const fakeState = (db as unknown as { __state: Record<string, TableState> }).__state;
    expect(fakeState.leads!.rows[0]!.org_id).toBe(otherOrg);
    expect(fakeState.approvals!.rows).toHaveLength(3);
    expect(fakeState.approvals!.rows.every((r) => r.agent_instance_id === otherInstance)).toBe(true);
  });

  it("stores the same source post separately for two tenants", async () => {
    const otherOrg = "00000000-0000-4000-8000-000000000101";
    const otherInstance = "00000000-0000-4000-8000-000000000102";
    const db = makeFakeDb({
      agent_instances: { rows: [
        { id: INSTANCE_ID, org_id: ORG_ID, role: "x_intern", status: "active" },
        { id: otherInstance, org_id: otherOrg, role: "x_intern", status: "active" },
      ] },
      leads: { rows: [] }, drafts: { rows: [] }, approvals: { rows: [] },
    });
    __setDbClientForTests(db);
    const app = createApp();
    const first = await postOutbound(app, { ...basePayload(), owner: { orgId: ORG_ID, agentInstanceId: INSTANCE_ID } });
    const second = await postOutbound(app, {
      ...basePayload(), owner: { orgId: otherOrg, agentInstanceId: otherInstance },
      drafts: basePayload().drafts.map((draft, i) => ({ ...draft, id: `00000000-0000-4000-8000-${String(20 + i).padStart(12, "0")}` })),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.__state.leads!.rows.map((row) => row.org_id).sort()).toEqual([ORG_ID, otherOrg].sort());
    expect(db.__state.leads!.rows.map((row) => row.external_id)).toEqual([LEAD_EXTERNAL_ID, LEAD_EXTERNAL_ID]);
  });

  it("does not write when the explicit owner does not match the platform instance", async () => {
    const db = makeFakeDb({
      agent_instances: {
        rows: [{ id: INSTANCE_ID, org_id: ORG_ID, role: "x_intern", status: "active" }],
        error: null,
      },
      leads: { rows: [], error: null },
      drafts: { rows: [], error: null },
      approvals: { rows: [], error: null },
    });
    __setDbClientForTests(db);

    const res = await postOutbound(createApp(), {
      ...basePayload(),
      owner: {
        orgId: ORG_ID,
        agentInstanceId: "00000000-0000-4000-8000-000000000999",
      },
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "no_active_instance" });

    const fakeState = (db as unknown as { __state: Record<string, TableState> }).__state;
    expect(fakeState.leads!.rows).toEqual([]);
    expect(fakeState.drafts!.rows).toEqual([]);
    expect(fakeState.approvals!.rows).toEqual([]);
  });

  it("keeps a passed requested reply actor-ready without persisting a human review gate", async () => {
    const db = makeFakeDb({
      agent_instances: { rows: [{ id: INSTANCE_ID, org_id: ORG_ID, role: "x_intern", status: "paused" }] },
      leads: { rows: [] }, drafts: { rows: [] }, approvals: { rows: [] },
    });
    __setDbClientForTests(db);
    const res = await postOutbound(createApp(), {
      ...basePayload(), owner: { orgId: ORG_ID, agentInstanceId: INSTANCE_ID }, replyRequestKey: "requested-revision-1",
    });
    expect(res.status).toBe(200);
    const state = (db as unknown as { __state: Record<string, TableState> }).__state;
    expect(state.drafts!.rows).toHaveLength(3);
    for (const draft of state.drafts!.rows) {
      expect(draft.payload).toMatchObject({ reply_request_key: "requested-revision-1" });
      expect((draft.payload as Row).human_review_required).toBeUndefined();
    }
    expect(state.approvals!.rows.filter((a) => a.status === "pending")).toHaveLength(1);
    expect(state.approvals!.rows.filter((a) => a.status === "skipped")).toHaveLength(2);
  });

  it("selects the first passing X reply after rejected variants and skips later passing siblings", async () => {
    const db = makeFakeDb({
      agent_instances: { rows: [{ id: INSTANCE_ID, org_id: ORG_ID, role: "x_intern", status: "active" }] },
      leads: { rows: [] }, drafts: { rows: [] }, approvals: { rows: [] },
    });
    __setDbClientForTests(db);
    const payload = basePayload();
    const failed = {
      pass: false,
      scores: { voice: 0.9, grounding: 0.9, relevance: 0.9, format: 1 },
      attempts: 1,
      reasons: ["failed"],
      judgeOk: true,
      judgeProvider: "jev" as const,
    };
    Object.assign(payload.drafts[0]!, { verifierMeta: failed });

    const res = await postOutbound(createApp(), payload);

    expect(res.status).toBe(200);
    expect(db.__state.approvals!.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        draft_id: DRAFT_ID_E,
        status: "skipped",
        decided_by: "automatic-review",
        skip_reason: "automatic-review-failed",
      }),
      expect.objectContaining({ draft_id: DRAFT_ID_T, status: "pending" }),
      expect.objectContaining({
        draft_id: DRAFT_ID_C,
        status: "skipped",
        decided_by: "automatic-review",
        skip_reason: "automatic-review-sibling",
      }),
    ]));
  });

  it.each([
    ["missing", undefined, "automatic-review-missing"],
    [
      "failed",
      {
        pass: false,
        scores: { voice: 0.9, grounding: 0.9, relevance: 0.9, format: 1 },
        attempts: 2,
        reasons: ["grounding failed"],
        judgeOk: true,
        judgeProvider: "jev" as const,
      },
      "automatic-review-failed",
    ],
    [
      "invalid judge",
      {
        pass: true,
        scores: { voice: 0.9, grounding: 0.9, relevance: 0.9, format: 1 },
        attempts: 2,
        reasons: ["judge unavailable"],
        judgeOk: false,
        judgeProvider: "none" as const,
      },
      "automatic-review-invalid-judge",
    ],
  ])("stores an X reply with a %s review as skipped", async (_label, verifierMeta, reason) => {
    const db = makeFakeDb({
      agent_instances: { rows: [{ id: INSTANCE_ID, org_id: ORG_ID, role: "x_intern", status: "active" }] },
      leads: { rows: [] }, drafts: { rows: [] }, approvals: { rows: [] },
    });
    __setDbClientForTests(db);

    const res = await postOutbound(createApp(), { ...basePayload(), verifierMeta });

    expect(res.status).toBe(200);
    expect(db.__state.approvals!.rows).toHaveLength(3);
    for (const approval of db.__state.approvals!.rows) {
      expect(approval).toMatchObject({
        status: "skipped",
        decided_by: "automatic-review",
        skip_reason: reason,
      });
      expect(approval.decided_at).toEqual(expect.any(String));
    }
  });

  it("stores a LinkedIn reply below the resolved voice floor as skipped", async () => {
    process.env.LINKEDIN_AUTOSEND_VOICE_FLOOR = "0.7";
    const linkedinInstance = "00000000-0000-4000-8000-000000000222";
    const db = makeFakeDb({
      agent_instances: { rows: [{ id: linkedinInstance, org_id: ORG_ID, role: "linkedin_intern", status: "active" }] },
      leads: { rows: [] }, drafts: { rows: [] }, approvals: { rows: [] },
    });
    __setDbClientForTests(db);
    const verifierMeta = {
      pass: true,
      scores: { voice: 0.69, grounding: 0.9, relevance: 0.9, format: 1 },
      attempts: 0,
      reasons: [],
      judgeOk: true,
      judgeProvider: "jev" as const,
    };

    try {
      const res = await postOutbound(createApp(), {
        ...basePayload(),
        platform: "linkedin",
        owner: { orgId: ORG_ID, agentInstanceId: linkedinInstance },
        verifierMeta,
      });

      expect(res.status).toBe(200);
      expect(db.__state.approvals!.rows).toHaveLength(3);
      expect(db.__state.approvals!.rows.every((approval) =>
        approval.status === "skipped"
        && approval.decided_by === "automatic-review"
        && approval.skip_reason === "automatic-review-low-voice"
      )).toBe(true);
    } finally {
      delete process.env.LINKEDIN_AUTOSEND_VOICE_FLOOR;
    }
  });

  it("rejects a relationship DM without an explicit owner", async () => {
    const db = makeFakeDb({
      agent_instances: {
        rows: [{ id: INSTANCE_ID, org_id: ORG_ID, role: "x_intern", status: "active" }],
        error: null,
      },
      leads: { rows: [], error: null },
      drafts: { rows: [], error: null },
      approvals: { rows: [], error: null },
    });
    __setDbClientForTests(db);

    const res = await postOutbound(createApp(), relationshipPayload());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_body" });
  });

  it("rejects a relationship DM with auto-send", async () => {
    const db = makeFakeDb({
      agent_instances: {
        rows: [{ id: INSTANCE_ID, org_id: ORG_ID, role: "x_intern", status: "active" }],
        error: null,
      },
      leads: { rows: [], error: null },
      drafts: { rows: [], error: null },
      approvals: { rows: [], error: null },
    });
    __setDbClientForTests(db);

    const res = await postOutbound(
      createApp(),
      relationshipPayload({
        owner: { orgId: ORG_ID, agentInstanceId: INSTANCE_ID },
        autoSend: {
          chosenDraftId: "relationship-draft-1",
          targetAt: "2026-05-17T18:05:00.000Z",
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_body" });
  });

  it("stores a valid LinkedIn relationship DM as drafted lead + pending approval with no send permission", async () => {
    const linkedinInstance = "00000000-0000-4000-8000-000000000222";
    const db = makeFakeDb({
      agent_instances: {
        rows: [{ id: linkedinInstance, org_id: ORG_ID, role: "linkedin_intern", status: "active" }],
        error: null,
      },
      leads: { rows: [], error: null },
      drafts: { rows: [], error: null },
      approvals: { rows: [], error: null },
    });
    __setDbClientForTests(db);

    const res = await postOutbound(

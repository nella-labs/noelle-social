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

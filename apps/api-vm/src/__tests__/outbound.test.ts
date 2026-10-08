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

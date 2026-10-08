import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { NoelleError, type NoelleContext } from "../context.js";
import type { ToolModule, ToolResult } from "../types.js";
import { guard, mdTable, text, truncate } from "../result.js";
import { limitOf, optBool, optStr, reqStr } from "./_shared.js";

// Generic DB-admin surface for the noelle schema. These four tools turn the MCP
// server into a full admin console for a chat operator: discover tables
// (list_tables), inspect one (describe_table), read anything (sql_query), and
// modify anything (sql_execute). Together they cover every long-tail need no
// hand-written per-entity tool anticipates — set a knob, reset a stuck row,
// flip a flag, backfill a column — so "run all of noelle from chat" doesn't
// require shipping a new tool for each new thing.
//
// Safety model (single operator, single configured org, no RLS — see env.ts):
//   • sql_query runs inside a READ ONLY transaction, so even a mistyped write
//     is rejected by Postgres, not just by a regex.
//   • sql_execute is gated by ctx.assertWritable() (NOELLE_MCP_READONLY), a
//     required confirm:true, and a DDL/privileged-statement guard that needs an
//     explicit allowDangerous:true for DROP/TRUNCATE/ALTER/GRANT/…; it runs in a
//     transaction that auto-rolls-back on any error.
//   • Both re-assert the per-statement timeout the connection already carries.

const SCHEMA = "noelle";

// Statements that can destroy data or change structure/privileges. Blocked
// unless the caller passes allowDangerous:true.
const DANGEROUS_RE =
  /\b(drop|truncate|alter\s+(table|schema|role|type|sequence|view|index|database)|grant|revoke|create\s+(role|extension|database)|reindex|vacuum|cluster)\b/i;

const tools: Tool[] = [
  {
    name: "noelle_list_tables",
    description:
      "Admin: list every base table in the noelle schema with column count, estimated row count, and on-disk size. The entry point for exploring the database before querying it. Read-only, schema-global (not org-scoped).",
    inputSchema: {
      type: "object",
      properties: {
        orderBy: {
          type: "string",
          enum: ["name", "rows", "size"],
          description: "Sort order (default 'name').",
        },
      },
    },
  },
  {
    name: "noelle_describe_table",
    description:
      "Admin: full schema of one noelle table — columns (type, nullable, default), primary key, foreign keys, and indexes. Read this before writing INSERT/UPDATE SQL against a table.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name within the noelle schema (e.g. leads)." },
      },
      required: ["table"],
    },
  },
  {
    name: "noelle_sql_query",
    description:
      "Admin: run an arbitrary READ-ONLY SELECT/WITH query against the noelle DB and get rows back as a table. The universal 'read ANY table / ad-hoc analytics' escape hatch. Runs inside a read-only transaction (writes are rejected by the DB). search_path is noelle,public so bare table names resolve. Single statement only.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A single SELECT or WITH statement." },
        limit: {
          type: "number",
          description: "Max rows rendered in the result (default 100, cap 1000). The query still runs in full for the total count.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "noelle_sql_execute",
    description:
      "Admin: run an arbitrary WRITE statement (INSERT/UPDATE/DELETE, or DDL when explicitly permitted) against the noelle DB — the universal 'modify/insert/delete ANY row' admin lever. Requires confirm:true. DROP/TRUNCATE/ALTER/GRANT and other structural/privileged statements additionally require allowDangerous:true. Runs in a transaction that rolls back on any error; supports RETURNING. Refused when NOELLE_MCP_READONLY is set.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The write statement to run (may include a RETURNING clause)." },
        confirm: { type: "boolean", description: "Must be true to actually execute. Without it, the statement is echoed back for review, not run." },
        allowDangerous: {
          type: "boolean",
          description: "Must be true to permit DROP/TRUNCATE/ALTER/GRANT/REVOKE and other structural or privileged statements.",
        },
      },
      required: ["query"],
    },
  },
];

async function listTables(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  const orderBy = optStr(args, "orderBy") ?? "name";
  const rows = await ctx.sql<
    Array<{ table_name: string; cols: number; est_rows: string; bytes: string }>
  >`
    select t.table_name,
      (select count(*)::int from information_schema.columns c
         where c.table_schema = ${SCHEMA} and c.table_name = t.table_name) as cols,
      coalesce((select reltuples::bigint from pg_class
         where oid = (${SCHEMA} || '.' || quote_ident(t.table_name))::regclass), 0) as est_rows,
      coalesce(pg_total_relation_size((${SCHEMA} || '.' || quote_ident(t.table_name))::regclass), 0) as bytes
    from information_schema.tables t
    where t.table_schema = ${SCHEMA} and t.table_type = 'BASE TABLE'`;

  const sorted = [...rows].sort((a, b) => {
    if (orderBy === "rows") return Number(b.est_rows) - Number(a.est_rows);
    if (orderBy === "size") return Number(b.bytes) - Number(a.bytes);
    return a.table_name.localeCompare(b.table_name);
  });

  const fmtSize = (b: string) => {
    const n = Number(b);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  };
  const table = mdTable(
    ["table", "cols", "~rows", "size"],
    sorted.map((r) => [r.table_name, r.cols, Number(r.est_rows).toLocaleString(), fmtSize(r.bytes)]),
  );
  return text(`**noelle schema** — ${rows.length} table(s)\n\n${table}`);
}

async function assertTableExists(ctx: NoelleContext, table: string): Promise<void> {
  const [ok] = await ctx.sql<Array<{ x: number }>>`
    select 1 as x from information_schema.tables
    where table_schema = ${SCHEMA} and table_name = ${table} limit 1`;
  if (!ok) throw new NoelleError(`No table noelle.${table}. Run noelle_list_tables to see options.`);
}

async function describeTable(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  const table = reqStr(args, "table");
  await assertTableExists(ctx, table);

  const cols = await ctx.sql<
    Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>
  >`
    select column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = ${SCHEMA} and table_name = ${table}
    order by ordinal_position`;

  const keys = await ctx.sql<
    Array<{ column_name: string; constraint_type: string; ref: string | null }>
  >`
    select kcu.column_name, tc.constraint_type,
      case when tc.constraint_type = 'FOREIGN KEY'
        then ccu.table_name || '.' || ccu.column_name else null end as ref
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
    left join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name and tc.constraint_type = 'FOREIGN KEY'
    where tc.table_schema = ${SCHEMA} and tc.table_name = ${table}
      and tc.constraint_type in ('PRIMARY KEY', 'FOREIGN KEY')`;

  const pk = new Set(keys.filter((k) => k.constraint_type === "PRIMARY KEY").map((k) => k.column_name));
  const fk = new Map(
    keys.filter((k) => k.constraint_type === "FOREIGN KEY").map((k) => [k.column_name, k.ref]),
  );

  const indexes = await ctx.sql<Array<{ indexname: string; indexdef: string }>>`
    select indexname, indexdef from pg_indexes
    where schemaname = ${SCHEMA} and tablename = ${table} order by indexname`;

  const colTable = mdTable(
    ["column", "type", "null", "key", "default"],
    cols.map((c) => [
      c.column_name,
      c.data_type,
      c.is_nullable === "YES" ? "" : "NOT NULL",
      pk.has(c.column_name) ? "PK" : fk.has(c.column_name) ? `FK→${fk.get(c.column_name)}` : "",
      c.column_default ? truncate(c.column_default, 40) : "",
    ]),
  );
  const idxTable = mdTable(
    ["index", "definition"],
    indexes.map((i) => [i.indexname, truncate(i.indexdef.replace(/^CREATE.*USING /, "USING "), 80)]),
  );
  return text(
    `## noelle.${table}\n\n**Columns (${cols.length})**\n\n${colTable}\n\n**Indexes (${indexes.length})**\n\n${idxTable}`,
  );
}

// Render a result set (array of row objects) as a markdown table, cell-safe.
function renderRows(rows: Array<Record<string, unknown>>, cap: number): string {
  const shown = rows.slice(0, cap);
  const headers = shown.length ? Object.keys(shown[0]!) : [];
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") return truncate(JSON.stringify(v), 60);
    return truncate(String(v), 60);
  };
  return mdTable(
    headers,
    shown.map((r) => headers.map((h) => cell(r[h]))),
  );
}

async function sqlQuery(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  const raw = reqStr(args, "query");
  const q = raw.trim().replace(/;\s*$/, ""); // tolerate a single trailing semicolon
  if (/;/.test(q)) {
    throw new NoelleError("noelle_sql_query runs a single statement only (found ';'). Split it or use one statement.");
  }
  if (!/^\s*(select|with)\b/i.test(q)) {
    throw new NoelleError("noelle_sql_query only runs SELECT/WITH. Use noelle_sql_execute for writes.");
  }
  const timeoutMs = Number(ctx.env.NOELLE_MCP_STATEMENT_TIMEOUT_MS);
  const rows = (await ctx.sql.begin(async (sql) => {
    await sql.unsafe("set transaction read only");
    await sql.unsafe(`set local statement_timeout = ${timeoutMs}`);
    return sql.unsafe(q);
  })) as unknown as Array<Record<string, unknown>>;

  const cap = limitOf(args, 100, 1000);
  const table = renderRows(rows, cap);
  const note = rows.length > cap ? ` (showing first ${cap})` : "";
  return text(`**${rows.length} row(s)**${note}\n\n${table}`);
}

async function sqlExecute(args: Record<string, unknown>, ctx: NoelleContext): Promise<ToolResult> {
  ctx.assertWritable("run a write SQL statement");
  const query = reqStr(args, "query");

  if (DANGEROUS_RE.test(query) && !(optBool(args, "allowDangerous") ?? false)) {
    throw new NoelleError(
      "This looks like a structural/privileged statement (DROP/TRUNCATE/ALTER/GRANT/…). Re-run with allowDangerous:true to permit it.",
    );
  }
  if (!(optBool(args, "confirm") ?? false)) {
    return text(
      "Refusing to execute without `confirm:true`. Review the statement, then re-run with confirm:true:\n\n```sql\n" +
        query +
        "\n```",
    );
  }

  const timeoutMs = Number(ctx.env.NOELLE_MCP_STATEMENT_TIMEOUT_MS);
  const result = (await ctx.sql.begin(async (sql) => {
    await sql.unsafe(`set local statement_timeout = ${timeoutMs}`);
    return sql.unsafe(query);
  })) as unknown as Array<Record<string, unknown>> & { count?: number };

  const affected = typeof result.count === "number" ? result.count : result.length;
  let out = `OK — ${affected} row(s) affected.`;
  if (result.length > 0) {
    out += `\n\n**RETURNING (${result.length})**\n\n${renderRows(result, 100)}`;
  }
  return text(out);
}

async function handle(
  name: string,
  args: Record<string, unknown>,
  ctx: NoelleContext,
): Promise<ToolResult | null> {
  switch (name) {
    case "noelle_list_tables":
      return guard(() => listTables(args, ctx));
    case "noelle_describe_table":
      return guard(() => describeTable(args, ctx));
    case "noelle_sql_query":
      return guard(() => sqlQuery(args, ctx));
    case "noelle_sql_execute":
      return guard(() => sqlExecute(args, ctx));
    default:
      return null;
  }
}

export const adminModule: ToolModule = { tools, handle };

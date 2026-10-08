#!/usr/bin/env node
// ONE-OFF BACKFILL: run the reply-polish pass (strip full stops, then one
// human typing slip) over replies that were drafted BEFORE the pass existed.
//
// New drafts are polished at outbound (packages/runtime/src/outboundClient.ts),
// so this only exists for the queue that was already written. It calls the SAME
// polishReplyBody the live path calls, so the two cannot drift. Scope is
// deliberately narrow:
//
//   - PENDING approvals only. A sent reply cannot be edited, and a skipped one
//     is not going out.
//   - kind='reply' only, same as the live pass: a DM is a cold first touch.
//   - NEVER a draft the operator has edited (payload.edited). Their words win.
//
// Dry by default. `--apply` writes. `--rate=N` overrides the env slip rate;
// note the full-stop strip is unconditional, so `--rate=0` still removes dots.
import { createRequire } from "node:module";
import { typoRateFromEnv } from "../packages/runtime/dist/humanTypos.js";
import { polishReplyBody } from "../packages/runtime/dist/replyPolish.js";
import { readFileSync } from "node:fs";

// pnpm does not hoist, so `postgres` resolves from the workspace that depends on
// it, not from the repo root where this script lives.
const postgres = createRequire(
  new URL("../packages/runtime/package.json", import.meta.url),
)("postgres");

const APPLY = process.argv.includes("--apply");
const rateArg = process.argv.find((a) => a.startsWith("--rate="));
const RATE = rateArg ? Number(rateArg.split("=")[1]) : typoRateFromEnv();

function dbUrl() {
  if (process.env.NOELLE_DATABASE_URL) return process.env.NOELLE_DATABASE_URL;
  const env = readFileSync(`${process.env.HOME}/.noelle/.env`, "utf8");
  const line = env.split("\n").find((l) => l.startsWith("NOELLE_DATABASE_URL="));
  if (!line) throw new Error("NOELLE_DATABASE_URL not found in env or ~/.noelle/.env");
  return line.slice("NOELLE_DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
}

const sql = postgres(dbUrl(), { max: 2 });

// `polish_backfill` is stamped on EVERY draft this script processes, including
// the ones it leaves unchanged, so a second --apply is a no-op instead of
// stacking a second typing slip onto an already-polished body. That is the
// failure this guard exists for: the full-stop strip is idempotent, but the slip
// is a 10% dice roll and re-running would land 11 more on a queue of 93.
const rows = await sql`
  select d.id, l.platform, d.payload->>'body' as body
  from noelle.approvals a
  join noelle.drafts d on d.id = a.draft_id
  join noelle.leads l on l.id = d.lead_id
  where a.status = 'pending'
    and d.payload->>'kind' = 'reply'
    and coalesce((d.payload->>'edited')::boolean, false) = false
    and not (d.payload ? 'polish_backfill')
  order by d.synced_at`;

console.log(`${rows.length} pending reply drafts, slip rate ${RATE}${APPLY ? "" : "  (DRY RUN)"}\n`);

let dotted = 0;
let slipped = 0;
for (const r of rows) {
  const out = polishReplyBody(r.body, { platform: r.platform, typoRate: RATE });
  const changed = out.body !== r.body;
  if (changed) {
    if (out.periodsStripped) dotted++;
    if (out.typo) slipped++;
    console.log(`[${r.platform}/${[out.periodsStripped ? "dots" : null, out.typo].filter(Boolean).join("+")}]`);
    console.log(`  -  ${r.body}`);
    console.log(`  +  ${out.body}`);
  }
  // Stamp even an unchanged draft, so it is out of scope for any later run.
  if (APPLY) {
    await sql`
      update noelle.drafts
      set payload = payload || ${sql.json({
        polish_backfill: true,
        ...(changed
          ? {
              body: out.body,
              char_count: [...out.body].length,
              ...(out.typo ? { human_typo: out.typo } : {}),
              ...(out.periodsStripped ? { periods_stripped: true } : {}),
            }
          : {}),
      })}
      where id = ${r.id}`;
  }
}

// rows.length is 0 once everything is stamped, and 0/0 prints "NaN%".
const pct = (n) => (rows.length === 0 ? "0.0" : ((n / rows.length) * 100).toFixed(1));
console.log(`\n${dotted}/${rows.length} had dots removed (${pct(dotted)}%), ${slipped} got a typing slip (${pct(slipped)}%)${APPLY ? " — written" : " — dry run, nothing written"}`);
await sql.end();

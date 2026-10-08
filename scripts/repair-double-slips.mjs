#!/usr/bin/env node
// ONE-OFF REPAIR: undo the second typing slip on drafts that were polished twice.
//
// WHAT HAPPENED: the typo backfill was run once (typos only), then re-run after
// the full-stop strip was added, before the re-run guard existed. Any draft that
// won the 10% dice roll BOTH times carries two slips, which reads as broken
// rather than human. The `human_typo` marker was overwritten by the second run,
// so the marker alone cannot tell them apart.
//
// FIX: the first run printed its output, so the exact post-first-run text of all
// seven mutated drafts is known and pinned below. The correct final body is that
// text with the full stops stripped, and nothing else. Any draft whose current
// body differs from that got a second slip and is restored.
//
// Dry by default; `--apply` writes.
import { createRequire } from "node:module";
import { stripSentencePeriods } from "../packages/runtime/dist/voiceSanitize.js";
import { readFileSync } from "node:fs";

const postgres = createRequire(
  new URL("../packages/runtime/package.json", import.meta.url),
)("postgres");

const APPLY = process.argv.includes("--apply");

// Verbatim stdout of the first backfill run: the body AFTER exactly one slip,
// BEFORE any full stops were stripped.
const AFTER_FIRST_RUN = [
  "cheap ugly tools are underrated. half my ops runs on scripts id never show anyone and they still save me hours every week",
  "improve and rescan sitting right next to each other would eat an hour of my day, and a 75 with no tuning at all on the the first pull is a good place to be starting from",
  "what happens to the running agents when the hotspot drops for a secnd, do they retry or just die quietly?",
  "a 300 second generation on a 3090 plus LUFS and key detection in the same window is a a stack i'd actually use. how close does the key detection get on dense mixes?",
  "getting a co-founder out of thta dead channel window is a wild trade.",
  "two months of building an eval on your own tasks and $12k out of pocket is a real bet. which field are you most curious about, one where you expect the leaderboard to flip?",
  "what does your iflter look like for clients who repost because their scope was garbage vs a real unsolved problem? i've read reposts that were just three rounds of a founder who couldn't describe what he wanted, and the language repeats there too.",
];

function dbUrl() {
  if (process.env.NOELLE_DATABASE_URL) return process.env.NOELLE_DATABASE_URL;
  const env = readFileSync(`${process.env.HOME}/.noelle/.env`, "utf8");
  const line = env.split("\n").find((l) => l.startsWith("NOELLE_DATABASE_URL="));
  if (!line) throw new Error("NOELLE_DATABASE_URL not found");
  return line.slice("NOELLE_DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
}

const sql = postgres(dbUrl(), { max: 2 });

const rows = await sql`
  select d.id, d.payload->>'body' as body
  from noelle.approvals a join noelle.drafts d on d.id = a.draft_id
  where a.status = 'pending' and d.payload->>'kind' = 'reply'`;

/** Match a known draft to its DB row by a distinctive opening, slip-tolerant. */
const keyOf = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);

let repaired = 0;
for (const known of AFTER_FIRST_RUN) {
  const want = stripSentencePeriods(known);
  const row = rows.find((r) => keyOf(r.body) === keyOf(want));
  if (!row) {
    console.log(`?  no pending draft matches: "${known.slice(0, 60)}…"`);
    continue;
  }
  if (row.body === want) {
    console.log(`ok single slip: ${row.body.slice(0, 70)}…`);
    continue;
  }
  repaired++;
  console.log(`\nDOUBLE SLIP ${row.id}`);
  console.log(`  now      ${row.body}`);
  console.log(`  restored ${want}`);
  if (APPLY) {
    await sql`
      update noelle.drafts
      set payload = payload || ${sql.json({ body: want, char_count: [...want].length })}
      where id = ${row.id}`;
  }
}

console.log(
  `\n${repaired}/${AFTER_FIRST_RUN.length} had a second slip${APPLY ? " — restored" : " — dry run, nothing written"}`,
);
await sql.end();

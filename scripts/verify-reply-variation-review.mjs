// Verify reply-variation admission, prompt overrides and shared policy owners.
// Runs as lint:reply-variation in the root lint command and local CI gate.
//
// Requires the runtime to be built (pnpm --filter @noelle/runtime build).
// Usage: pnpm lint:reply-variation
import { readFileSync } from "node:fs";
import { markersForEnergy, pickGenZMarker, GENZ_MARKERS } from "../packages/runtime/dist/index.js";

const R = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(`${R}/${p}`, "utf8");
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "OK  " : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) fail++;
};

// F2: null energy must block the loud tier (the prod configuration).
const nullPool = markersForEnergy(null);
check("F2 markersForEnergy(null) is plain-only", nullPool.every((m) => m.tier === "plain"),
  `${nullPool.length}/${GENZ_MARKERS.length} markers`);
let loudSeen = 0;
for (let s = 1; s <= 500; s++) {
  const m = pickGenZMarker(() => (s % 500) / 500, null);
  if (m && m.tier === "loud") loudSeen++;
}
check("F2 no loud marker ever picked with null energy", loudSeen === 0, `${loudSeen} loud picks`);

// F3: Every Reddit output-format sentence default must allow the assigned shape.
const rp = read("apps/reddit-intern/src/lib/prompts.ts");
const bare = (rp.match(/1-4 sentences, conversational\)\./g) || []).length;
const carved = (rp.match(/REPLACES this 1-4 sentence default/g) || []).length;
const defaults = (rp.match(/1-4 sentences, conversational\)/g) || []).length;
check("F3 no un-carved '1-4 sentences' line remains", bare === 0 && defaults > 0 && carved === defaults,
  `bare=${bare} carved=${carved} defaults=${defaults}`);

// F4: every REPLY-DRAFTING system prompt acknowledges the block.
//
// The rule: a system prompt that can receive a per-lead marker block must
// declare it. Prompts that never see one are named and excused, so adding a new
// drafting prompt fails here rather than silently going unannounced.
const NO_MARKER_PROMPTS = new Set([
  "SYSTEM_LINKEDIN_INTRO",   // a DM/intro prompt; the marker never applies to a DM
  "SYSTEM_STYLE_EXTRACTOR",  // not a drafting prompt at all
]);
for (const [name, p] of [
  ["X", "apps/x-intern/src/lib/prompts.ts"],
  ["LinkedIn", "apps/linkedin-intern/src/lib/prompts.ts"],
  ["Reddit", "apps/reddit-intern/src/lib/prompts.ts"],
]) {
  const src = read(p);
  check(`F4 ${name} declares GENZ_MARKER_RULE`, src.includes("const GENZ_MARKER_RULE"));
  check(`F4 ${name} rule carries an OVERRIDES clause`, /OVERRIDES the general ban/.test(src));
  const systems = [...src.matchAll(/^export const (SYSTEM_\w+)/gm)].map((m) => m[1]);
  const drafting = systems.filter((n) => !NO_MARKER_PROMPTS.has(n));
  const renders = (src.match(/\$\{GENZ_MARKER_RULE\}/g) || []).length;
  check(`F4 ${name}: every drafting system prompt renders it`, renders === drafting.length,
    `${renders} renders for ${drafting.length} drafting prompts (${drafting.join(", ")})`);
}

// F5: the memory note names the energy subsets as the binding floor.
const fv = read("packages/runtime/src/formVariants.ts");
check("F5 memory note cites the energy-scoped floor",
  fv.includes("MIN_CANDIDATES = 2") && fv.includes("ENERGY_SHAPE_IDS first"));
check("F5 stale '7 candidates' claim is gone", !fv.includes("leaving 7 candidates"));

// F6: the Lyra guard asserts directives, not unmatchable prefixes.
const lt = read("apps/linkedin-intern/src/workers/drafter-tick.test.ts");
check("F6 guard uses loud DIRECTIVES", lt.includes("loudDirectives") && lt.includes("m.tier === \"loud\""));
check("F6 unmatchable prefix guard is gone", !lt.includes('once: "${loud}'));
check("F6 guard proves a plain marker rendered", lt.includes("expect(sawPlain).toBe(true)"));

// The simulator presents itself as Vega's production directive assignment. Scoped
// markers default closed so Reddit stays unchanged; the simulator must therefore
// opt into Vega's X pool just like the real worker does.
const sim = read("scripts/reply-variation-sim.mjs");
check(
  "RULE Vega simulator opts into the X marker pool",
  /createGenZMarkerRotation\(4,\s*\{\s*platform:\s*["']x["']\s*\}\)/s.test(sim),
);


// ---------------------------------------------------------------------------
// Check policy ownership and shape-aware length constraints across every lane.
// ---------------------------------------------------------------------------
import { readdirSync } from "node:fs";

// No drafter may keep a LOCAL copy of TONE_FIRST_ENERGIES. It must agree with
// ENERGY_SHAPE_IDS, and shapesForEnergy fails OPEN, so a drifted copy gives an
// unscoped rotation with every test green.
for (const app of ["x-intern", "linkedin-intern", "reddit-intern"]) {
  const p = `apps/${app}/src/workers/drafter-tick.ts`;
  let src = "";
  try { src = read(p); } catch { continue; }
  check(`RULE ${app} has no local TONE_FIRST_ENERGIES`,
    !/\bconst TONE_FIRST_ENERGIES\s*[:=]/.test(src));
}

// Every length word in a prompt renderer that sits below the shape block must
// be guarded by shapeBlock/shapeAssigned. A bare one is the last word on
// length and silently beats the shape.
const LENGTH_WORDS = /"[^"\n]*\b(?:1-2 sentences|1-4 sentences|ONE short|ONE SHORT)\b[^"\n]*"/g;
for (const app of ["x-intern", "linkedin-intern", "reddit-intern"]) {
  const p = `apps/${app}/src/workers/drafter-tick.ts`;
  let src = "";
  try { src = read(p); } catch { continue; }
  // Strip // line comments first: the comments EXPLAINING this rule quote the
  // very strings it looks for, and a checker that trips on its own
  // documentation is noise, not a check.
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  const bare = [];
  for (const m of code.matchAll(LENGTH_WORDS)) {
    // Guarded when a shape-aware ternary HEAD opens within the preceding few
    // lines. The head may carry other conditions (`shapeAssigned ||
    // registerBlock`), so match the reference and the `?` separately rather
    // than requiring them to be adjacent.
    const before = code.slice(Math.max(0, m.index - 500), m.index);
    const head = before.lastIndexOf("args.shape");
    const guarded = head >= 0 && before.slice(head).includes("?");
    if (!guarded) bare.push(code.slice(0, m.index).split("\n").length);
  }
  check(`RULE ${app} has no unguarded length word below a shape block`, bare.length === 0,
    bare.length ? `lines ${bare.join(", ")}` : "");
}

// The typo rate is documented in more than one place; all of them must agree
// with the constant.
for (const p of ["packages/runtime/src/humanTypos.ts", "packages/runtime/src/outboundClient.ts"]) {
  const src = read(p);
  const stale = [...src.matchAll(/default 10%|\(10% by default\)/g)].length;
  check(`RULE ${p.split("/").pop()} documents the CURRENT typo rate`, stale === 0,
    stale ? `${stale} stale "10%" mentions` : "");
}


// Apply the length-word rule to system prompts as well as renderers.
// `[ \t]*` and not `\s*`: \s matches a NEWLINE, so the anchored pattern spanned
// lines and pulled "short" off a later one, flagging an "Exactly ONE draft with
// angle empathetic" DRAFT-COUNT line as a length rule.
const PROMPT_LENGTH_WORDS =
  /^-?[ \t]*(?:Exactly )?ONE?\b[^\n]*\b(?:short|1 to 2 sentences|1-2 sentences)\b[^\n]*$/gim;
for (const app of ["x-intern", "linkedin-intern", "reddit-intern"]) {
  const src = read(`apps/${app}/src/lib/prompts.ts`);
  const bare = [];
  for (const m of src.matchAll(PROMPT_LENGTH_WORDS)) {
    // A length statement is fine as long as the SAME line names the shape as
    // the thing that overrides it.
    if (!/ASSIGNED SHAPE/i.test(m[0])) bare.push(src.slice(0, m.index).split("\n").length);
  }
  check(`RULE ${app} prompts: every length line names the shape override`, bare.length === 0,
    bare.length ? `lines ${bare.join(", ")}` : "");
}

console.log(fail === 0 ? "\nALL REPLY VARIATION CHECKS PASS" : `\n${fail} REGRESSED`);
process.exit(fail === 0 ? 0 : 1);

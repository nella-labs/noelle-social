#!/usr/bin/env node
// Generate REAL before/after reply drafts for #557.
//
// The sibling reply-variation-sim.mjs measures the rules. This one shows the
// output: it renders Vega's real SYSTEM_X_BASE prompt with the directive stack
// each rule set would assign, calls the local `claude -p` subscription backend
// (the same backend the drafter uses in production), and prints the two replies
// side by side for the same post.
//
// Deliberately small — a handful of posts. This is an illustration of what the
// rules produce, not evidence about the distribution; the simulator is what
// measures that, over hundreds of leads. One sample of one draft can look good
// or bad by luck.
//
// Requires the runtime to be built and `claude` on PATH.
// Usage: node scripts/reply-variation-samples.mjs

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  X_FORM_VARIANTS,
  renderAssignedShapeBlock,
  renderGenZMarkerBlock,
  GENZ_MARKERS,
  polishReplyBody,
  stripDisallowedEmoji,
} from "../packages/runtime/dist/index.js";
import { renderRegisterBlock, registersForEnergy } from "../packages/runtime/dist/register.js";
import { SYSTEM_X_BASE } from "../apps/x-intern/dist/lib/prompts.js";

const run = promisify(execFile);

// The posts. A spread of energies so the tone-first split is visible.
const POSTS = [
  {
    handle: "dhh",
    energy: "analytical",
    text: "spent the morning watching an AI agent re-read the same 40 files on every single prompt. the context window isn't the bottleneck. the bill is.",
  },
  {
    handle: "swyx",
    energy: "joke",
    text: "my agent opened a PR to fix a bug, the PR introduced two bugs, then it opened a PR to fix those. i've invented perpetual motion",
  },
  {
    handle: "levelsio",
    energy: "celebration",
    text: "just crossed $12k MRR on the side project. 14 months. no funding, no team, no ads.",
  },
  {
    handle: "someone",
    energy: "vent",
    text: "third week in a row where the deploy passed CI and broke prod. i am so tired of this pipeline",
  },
];

// The directive stacks, chosen by hand rather than sampled, so the comparison is
// legible: BEFORE is what the old rules would produce for that energy, AFTER is
// a representative pick from the wider space the new rules opened. Both sides
// then go through the same model and the same polish pass.
const CASES = [
  {
    post: POSTS[0],
    before: { shape: "THREE_BEAT" },
    after: { shape: "MICRO" },
  },
  {
    post: POSTS[1],
    // A joke was tone-first: register, and no shape at all.
    before: { register: "DEADPAN" },
    after: { shape: "RIFF", marker: "UNSERIOUS" },
  },
  {
    post: POSTS[2],
    before: { register: "HYPE" },
    after: { shape: "ONE_SHORT", marker: "NGL" },
  },
  {
    post: POSTS[3],
    before: { register: "SLANG" },
    after: { shape: "TWO_FLAT", marker: "LOWKEY" },
  },
];

function blocksFor(spec, energy) {
  const out = [];
  if (spec.shape) {
    const v = X_FORM_VARIANTS.find((x) => x.id === spec.shape);
    if (!v) throw new Error(`unknown shape ${spec.shape}`);
    out.push(renderAssignedShapeBlock(v));
  }
  if (spec.register) {
    const r = registersForEnergy(energy).find((x) => x.id === spec.register);
    if (!r) throw new Error(`register ${spec.register} not reachable on ${energy}`);
    out.push(renderRegisterBlock(r, "the reply"));
  }
  if (spec.marker) {
    const m = GENZ_MARKERS.find((x) => x.id === spec.marker);
    if (!m) throw new Error(`unknown marker ${spec.marker}`);
    out.push(renderGenZMarkerBlock(m));
  }
  return out;
}

function userPrompt(post, spec) {
  return [
    `Lead post by @${post.handle}:`,
    post.text,
    "",
    ...blocksFor(spec, post.energy),
    "",
    "Draft exactly ONE reply in the exact JSON shape the system prompt specifies, plus one dm.",
  ].join("\n");
}

async function attempt(post, spec) {
  const prompt = `${SYSTEM_X_BASE}\n\n---\n\n${userPrompt(post, spec)}`;
  const { stdout } = await run("claude", ["-p", prompt], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180_000,
  });
  const m = stdout.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let body;
  try {
    body = JSON.parse(m[0]).drafts?.[0]?.body;
  } catch {
    // A truncated stream leaves unbalanced JSON. Pull the first body field out
    // directly rather than throwing the whole draft away.
    body = m[0].match(/"body"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
    if (body) body = body.replace(/\\n/g, " ").replace(/\\"/g, '"');
  }
  if (!body) return null;
  // The same deterministic cleanup the live drafter applies, in the same order:
  // the emoji strip runs in the drafter (where the post text is in scope), the
  // polish pass runs later in outboundClient. typoRate is 0 here so the two
  // sides differ only by their directives, not by a coin flip.
  const cleaned = stripDisallowedEmoji(body, { postText: post.text });
  return polishReplyBody(cleaned, { platform: "x", typoRate: 0 }).body;
}

async function draft(post, spec) {
  for (let i = 0; i < 3; i++) {
    try {
      const out = await attempt(post, spec);
      if (out) return out;
    } catch (err) {
      if (i === 2) return `(error: ${String(err).slice(0, 100)})`;
    }
  }
  return "(no draft after 3 attempts)";
}

const label = (s) =>
  [s.shape && `shape:${s.shape}`, s.register && `register:${s.register}`, s.marker && `marker:${s.marker}`]
    .filter(Boolean)
    .join(" + ");

const rows = [];
for (const c of CASES) {
  const [b, a] = await Promise.all([draft(c.post, c.before), draft(c.post, c.after)]);
  rows.push({ c, b, a });
  console.error(`done: ${c.post.handle}`);
}

console.log("\n### Real drafts, same post, same model, same polish pass\n");
for (const { c, b, a } of rows) {
  console.log(`**@${c.post.handle} (${c.post.energy})** — ${c.post.text}\n`);
  console.log("| | directives | reply | chars |");
  console.log("|---|---|---|---|");
  console.log(`| before | ${label(c.before)} | ${b.replace(/\n/g, " ")} | ${b.length} |`);
  console.log(`| after | ${label(c.after)} | ${a.replace(/\n/g, " ")} | ${a.length} |`);
  console.log("");
}

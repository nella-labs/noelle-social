import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("./lead-flow-watchdog.mjs", import.meta.url));
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const row = (id, name, running = false, leads = 1) =>
  [id, name, "x_intern", running ? "active" : "paused", running ? "t" : "f",
    running ? "t" : "f", "5", "08:00", "90", "f", String(leads), "0"].join("|");

function run(rows, after = rows, name = "Fixture", dry = false) {
  const dir = mkdtempSync(join(tmpdir(), "noelle-watchdog-"));
  const trace = join(dir, "trace.jsonl");
  const captured = join(dir, "captured.jsonl");
  const marker = join(dir, "unexpected-command");
  const capture = join(dir, "capture.cjs");
  const preload = join(dir, "preload.cjs");
  writeFileSync(capture, `require("node:fs").appendFileSync(process.env.WATCHDOG_CAPTURE, JSON.stringify(process.argv.slice(2))+"\\n");`);
  writeFileSync(preload, `
const cp = require("node:child_process"), fs = require("node:fs");
const original = cp.execFile;
let reads = 0;
cp.execFile = function(file, args, options, callback) {
  fs.appendFileSync(process.env.WATCHDOG_TRACE, JSON.stringify({file,args})+"\\n");
  if (file === "psql") {
    const select = args.at(-1).trim().startsWith("SELECT");
    const stdout = select ? JSON.parse(process.env.WATCHDOG_ROWS)[reads++ === 0 ? 0 : 1] : "";
    queueMicrotask(() => callback(null, stdout, ""));
    return {};
  }
  if (file !== "/bin/sh") throw new Error("Unexpected external process");
  return original(file, args, options, callback);
};
cp.execFile[Symbol.for("nodejs.util.promisify.custom")] = (file, args, options) =>
  new Promise((resolve, reject) => cp.execFile(file, args, options, (error, stdout, stderr) =>
    error ? reject(error) : resolve({stdout,stderr})));
const timer = global.setTimeout;
global.setTimeout = (callback, ms, ...args) => timer(callback, ms === 75000 ? 0 : ms, ...args);
require("node:module").syncBuiltinESMExports();
`);
  try {
    const injected = name.replace("MARKER", marker);
    const beforeRows = rows.map(value => value.replace("NAME", injected));
    const afterRows = after.map(value => value.replace("NAME", injected));
    let output, status = 0;
    try {
      output = execFileSync(process.execPath, ["--require", preload, entry, "--json", ...(dry ? ["--dry-run"] : [])], {
        encoding: "utf8", timeout: 5000,
        env: { ...process.env, NODE_OPTIONS: "", WATCHDOG_TRACE: trace, WATCHDOG_CAPTURE: captured,
          WATCHDOG_ROWS: JSON.stringify([beforeRows.join("\n"), afterRows.join("\n")]),
          NOELLE_ALERT_CMD: `${process.execPath} ${capture}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) { status = error.status; output = error.stdout?.toString(); }
    assert.ok(output, "Watchdog returned no JSON output");
    return { status, report: JSON.parse(output),
      calls: readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line)),
      messages: existsSync(captured) ? readFileSync(captured, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [],
      commandRan: existsSync(marker), injected };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("alert labels remain literal data for the configured notification command", () => {
  const seen = run([row(firstId, "NAME", false, 0)], undefined, "$(touch MARKER)");
  assert.equal(seen.status, 1);
  assert.equal(seen.commandRan, false);
  assert.equal(seen.messages.length, 1);
  assert.ok(seen.messages[0][0].includes(seen.injected));
});

test("refire verification follows the selected instance when names repeat", () => {
  const seen = run([row(firstId, "Shared", true), row(secondId, "Shared")],
    [row(firstId, "Shared", true), row(secondId, "Shared")]);
  assert.equal(seen.status, 1);
  const fixed = seen.report.findings.find(value => value.verdict === "fixed");
  assert.equal(fixed.verified, false);
  const updates = seen.calls.filter(call => call.file === "psql" && call.args.at(-1).startsWith("UPDATE"));
  assert.equal(updates.length, 1);
  assert.ok(updates[0].args.at(-1).includes(secondId));
});

test("an actual matching instance recovery verifies successfully", () => {
  const seen = run([row(firstId, "Fixture")], [row(firstId, "Renamed", true)]);
  assert.equal(seen.status, 0);
  assert.equal(seen.report.findings[0].verified, true);
  assert.equal(seen.messages.length, 0);
});

test("dry-run reports without updating state or invoking notifications", () => {
  const seen = run([row(firstId, "Fixture")], undefined, "Fixture", true);
  assert.equal(seen.status, 0);
  assert.equal(seen.calls.filter(call => call.file === "/bin/sh").length, 0);
  assert.equal(seen.calls.filter(call => call.args.at(-1).startsWith("UPDATE")).length, 0);
});

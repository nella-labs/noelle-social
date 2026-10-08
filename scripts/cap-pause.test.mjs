import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entry = fileURLToPath(new URL('./cap-pause.sh', import.meta.url));

test('budget commands target only the configured installation workspace', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'noelle-cap-pause-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = join(base, 'bin');
  mkdirSync(bin);
  const trace = join(base, 'sql');
  writeFileSync(join(bin, 'psql'), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$CAP_TEST_TRACE"\n', { mode: 0o700 });
  const envFile = join(base, '.env');
  writeFileSync(envFile, 'NOELLE_DATABASE_URL=postgresql://fixture.invalid/test\n');
  writeFileSync(join(base, 'config.json'), JSON.stringify({ org: { slug: 'fixture-team' } }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NOELLE_HOME: base,
    NOELLE_ENV_FILE: envFile, NOELLE_MCP_ORG: '', NOELLE_ORG_SLUG: '', CAP_TEST_TRACE: trace };
  const valid = spawnSync('bash', [entry, 'off'], { env, encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(readFileSync(trace, 'utf8'), /where slug = 'fixture-team'/);
  rmSync(trace);
  const invalid = spawnSync('bash', [entry, 'off'], { env: { ...env, NOELLE_MCP_ORG: "team' OR true--" }, encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.equal(existsSync(trace), false);
  writeFileSync(join(base, 'config.json'), '{}');
  const missing = spawnSync('bash', [entry, 'off'], { env, encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.equal(existsSync(trace), false);
});

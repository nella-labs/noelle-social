import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportPublicSnapshot, selectPublicPaths } from './export-public-snapshot.mjs';

test('private captures are excluded without matching unrelated runtime paths', () => {
  const keep = ['apps/app/src/.agents.ts', 'packages/runtime/src/tasks/queue.ts',
    'docs/research-guide.md', 'apps/cli/src/index.ts', 'packages/db/schema/0001.sql',
    '.env.example', 'pnpm-lock.yaml', 'LICENSE', '.github/workflows/ci.yml', 'CLAUDE.md'];
  assert.deepEqual(selectPublicPaths([...keep, '.mcp.json', 'docs/multi-session.md', 'style-eval.mjs',
    'infra/launchd/com.pablo.noelle-lead-flow.plist', '.private/plan.md',
    '.claude/settings.json', '.agents/skills/a.md', 'tasks/review.md',
    'docs/superpowers/plan.md', 'docs/research/capture.jsonl']), keep);
});

test('export reads the exact committed tree and preserves source files', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'noelle-public-export-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = join(base, 'source');
  mkdirSync(source);
  const git = (...args) => execFileSync('git', args, { cwd: source, stdio: 'pipe' });
  git('init', '-q');
  for (const path of ['README.md', 'LICENSE', 'package.json', 'pnpm-lock.yaml',
    'apps/app/source.ts', 'docs/research/private.jsonl']) {
    mkdirSync(join(source, path, '..'), { recursive: true });
    writeFileSync(join(source, path), `committed ${path}\n`);
  }
  git('add', '--', 'README.md', 'LICENSE', 'package.json', 'pnpm-lock.yaml');
  git('-c', 'user.name=Release Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'Test release metadata');
  git('add', '--', 'apps/app/source.ts', 'docs/research/private.jsonl');
  git('-c', 'user.name=Release Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'Test release tree');
  writeFileSync(join(source, 'README.md'), 'uncommitted data\n');
  writeFileSync(join(source, '.env'), 'untracked test data\n');
  const output = join(base, 'public');
  const result = exportPublicSnapshot(output, 'HEAD', source);
  assert.equal(result.files, 5);
  assert.equal(result.excludedFiles, 1);
  assert.equal(readFileSync(join(output, 'README.md'), 'utf8'), 'committed README.md\n');
  assert.ok(existsSync(join(output, 'apps/app/source.ts')));
  assert.equal(existsSync(join(output, '.env')), false);
  assert.equal(existsSync(join(output, 'docs/research/private.jsonl')), false);
  assert.equal(existsSync(join(output, '.git')), false);
  assert.throws(() => exportPublicSnapshot(output, 'HEAD', source), /must be new/);
  assert.throws(() => exportPublicSnapshot(join(source, 'export'), 'HEAD', source), /outside/);
  symlinkSync(source, join(base, 'alias'));
  assert.throws(() => exportPublicSnapshot(join(base, 'alias', 'export'), 'HEAD', source), /outside/);
});

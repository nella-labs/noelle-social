import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRIVATE_PREFIXES = [
  '.private/', '.claude/', '.agents/', 'tasks/', 'docs/superpowers/', 'docs/research/',
];
export const PRIVATE_FILES = new Set([
  '.mcp.json', 'docs/multi-session.md', 'style-eval.mjs',
  'infra/launchd/com.pablo.noelle-lead-flow.plist',
]);

export function selectPublicPaths(paths) {
  return paths.filter((path) => !PRIVATE_FILES.has(path)
    && !PRIVATE_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

function git(args, cwd, encoding = 'utf8') {
  const result = spawnSync('git', args, { cwd, encoding, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Git could not read the requested snapshot.');
  return result.stdout;
}

export function exportPublicSnapshot(output, ref = 'HEAD', cwd = process.cwd()) {
  const source = git(['rev-parse', '--show-toplevel'], cwd).trim();
  const destination = resolve(output);
  if (existsSync(destination)) throw new Error('The output directory must be new.');
  const parent = realpathSync(dirname(destination));
  const fromSource = relative(realpathSync(source), resolve(parent, basename(destination)));
  if (!fromSource || (!fromSource.startsWith('..' + '/') && !isAbsolute(fromSource))) {
    throw new Error('The output directory must be outside the source checkout.');
  }
  const commit = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], source).trim();
  const entries = git(['ls-tree', '-rz', commit], source).split('\0').filter(Boolean);
  const tracked = entries.map((entry) => entry.slice(entry.indexOf('\t') + 1));
  const paths = selectPublicPaths(tracked);
  const selected = new Set(paths);
  if (entries.some((entry) => entry.startsWith('120000 ') && selected.has(entry.slice(entry.indexOf('\t') + 1)))) {
    throw new Error('Public snapshot symlinks require explicit review.');
  }
  if (paths.some((path) => isAbsolute(path) || path.split('/').includes('..'))) {
    throw new Error('The snapshot contains an unsafe path.');
  }
  for (const path of ['README.md', 'LICENSE', 'package.json', 'pnpm-lock.yaml']) {
    if (!selected.has(path)) throw new Error(`Required public file is missing: ${path}`);
  }
  const archive = git(['archive', '--format=tar', commit, '--', ...paths], source, null);
  mkdirSync(destination, { mode: 0o700 });
  try {
    const result = spawnSync('tar', ['-xf', '-', '-C', destination], { input: archive, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('The snapshot archive could not be extracted.');
    if (paths.some((path) => !existsSync(resolve(destination, path)))) {
      throw new Error('The archive omitted selected files; inspect export attributes.');
    }
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  return { output: destination, commit, files: paths.length, excludedFiles: tracked.length - paths.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    process.stderr.write('Usage: node scripts/export-public-snapshot.mjs <new-output-directory> [ref]\n');
    process.exitCode = 2;
  } else {
    try { process.stdout.write(`${JSON.stringify(exportPublicSnapshot(process.argv[2], process.argv[3]))}\n`); }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  }
}

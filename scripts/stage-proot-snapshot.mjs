#!/usr/bin/env node
// Candidate snapshot only: tracked allowlisted files plus explicitly named new
// runtime input. This intentionally does not infer untracked files from globs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { scanRuntimePayload } from './verify-runtime-payload.mjs';
import { createGitBlobReader } from './stage-runtime-payload.mjs';

const [sourceArg, outputArg, sourceMode = 'checkout', requestedRevision] = process.argv.slice(2);
if (!sourceArg || !outputArg || !['checkout', 'git-objects'].includes(sourceMode) || (requestedRevision !== undefined && sourceMode !== 'git-objects')) throw new Error('Usage: stage-proot-snapshot.mjs SOURCE EMPTY_DESTINATION [checkout|git-objects] [COMMIT]');
const source = resolve(sourceArg), output = resolve(outputArg);
const git = (...args) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: source, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
if (requestedRevision !== undefined && (!/^[0-9a-f]{40}$/.test(requestedRevision) || git('cat-file', '-t', requestedRevision).trim() !== 'commit')) throw new Error('COMMIT must be a full commit SHA');
const head = git('rev-parse', '--verify', `${requestedRevision || 'HEAD'}^{commit}`).trim();
const dirty = Boolean(git('status', '--porcelain=v1', '--untracked-files=all'));
const tree = new Map(git('ls-tree', '-r', '-z', head).split('\0').filter(Boolean).map(row => {
  const tab = row.indexOf('\t');
  const [mode, type, oid] = row.slice(0, tab).split(' ');
  return [row.slice(tab + 1), { mode, type, oid }];
}));
const reader = sourceMode === 'git-objects' ? createGitBlobReader(source) : null;
try {
const manifestBytes = reader ? await reader.read(tree.get('packaging/runtime-payload.json').oid)
  : await readFile(join(source, 'packaging/runtime-payload.json'));
const spec = JSON.parse(manifestBytes.toString('utf8')).profiles.desktop;
const explicit = ['lib/proot-local-pairing.mjs', 'lib/proot-account-link-state.mjs',
  'chat/proot-account-link-routes.mjs', 'chat/approval-context-review.mjs',
  'chat/posix-shell-ast.mjs', 'chat/router-run-review-routes.mjs',
  'chat/run-review-capability.mjs', 'third_party_licenses/mvdan-sh-BSD-3-Clause.txt'];
const tracked = sourceMode === 'git-objects' ? [...tree.keys()] : git('ls-files', '-z').split('\0').filter(Boolean);
const selected = new Set(tracked.filter(name =>
  (spec.files.includes(name) || spec.prefixes.some(p => name.startsWith(p))) &&
  !spec.exclude.some(p => name === p || (p.endsWith('/') && name.startsWith(p))) &&
  !name.startsWith('desktop/') && !name.startsWith('packaging/')));
for (const name of explicit) {
  if (reader && !tree.has(name)) throw new Error(`Required PRoot input is not committed: ${name}`);
  selected.add(name);
}
const files = [];
for (const name of [...selected].sort()) {
  if (name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error(`Unsafe path: ${name}`);
  const committed = tree.get(name);
  let bytes;
  if (reader) {
    if (!committed || committed.type !== 'blob' || !['100644', '100755'].includes(committed.mode)) throw new Error(`Invalid committed PRoot input: ${name}`);
    bytes = await reader.read(committed.oid);
  } else {
    let cursor = source;
    for (const part of name.split('/')) {
      cursor = join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`Symlink in input: ${name}`);
    }
    if (!(await lstat(cursor)).isFile()) throw new Error(`Not a regular file: ${name}`);
    bytes = await readFile(cursor);
  }
  const mode = committed?.mode === '100755' ? 0o755 : 0o644;
  const target = join(output, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: 'wx', mode });
  files.push({ path: name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, mode });
}
if (!reader && git('rev-parse', 'HEAD').trim() !== head) throw new Error('Source revision changed while staging');
const scan = await scanRuntimePayload(output);
if (!scan.ok) throw new Error(`Snapshot security scan failed: ${JSON.stringify(scan.findings)}`);
if (!reader) for (const file of files) {
  const current = await readFile(join(source, file.path));
  if (createHash('sha256').update(current).digest('hex') !== file.sha256) throw new Error(`Source changed during staging: ${file.path}`);
}
await writeFile(join(output, 'proot-source-manifest.json'), `${JSON.stringify({ schemaVersion: 1, sourceRevision: head, sourceMode, workingTreeDirty: dirty, files }, null, 2)}\n`, { flag: 'wx' });
await writeFile(join(output, '.agentoc-source-commit'), `${head}\n`, { flag: 'wx' });
if (reader) await reader.close();
} catch (error) {
  reader?.abort();
  throw error;
}

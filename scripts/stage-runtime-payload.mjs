#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { scanRuntimePayload } from './verify-runtime-payload.mjs';

const exec = promisify(execFile);
const manifestPath = new URL('../packaging/runtime-payload.json', import.meta.url);
const windowsBuildInputs = [
  'android/app/src/main/res/drawable-nodpi/adaptive_foreground_png.png',
  'static/desktop/agentoc-android-logo.png',
  ...['package.json', 'package-lock.json', 'main.cjs', 'preload.cjs', 'update-check.cjs', 'wait.html', 'stage-windows.mjs'].map(name => `desktop/${name}`),
];

// Read immutable blobs from a single commit without a second checkout. The
// batch protocol keeps binary assets exact and bounds memory to one blob.
function createGitBlobReader(source) {
  const child = spawn('git', ['--no-optional-locks', 'cat-file', '--batch'], { cwd: source, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', code => code === 0 ? resolveExit() : rejectExit(new Error(`Git blob reader failed: ${stderr}`)));
  });
  // Attach a handler immediately so a failed child cannot become an unhandled rejection.
  exit.catch(() => {});
  const iterator = child.stdout[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  async function fill(size) {
    const chunks = [pending];
    let length = pending.length;
    while (length < size) {
      const next = await iterator.next();
      if (next.done) throw new Error('Git blob reader ended unexpectedly');
      chunks.push(next.value);
      length += next.value.length;
    }
    if (chunks.length > 1) pending = Buffer.concat(chunks, length);
  }
  async function read(oid) {
    child.stdin.write(`${oid}\n`);
    let newline;
    while ((newline = pending.indexOf(10)) < 0) {
      if (pending.length > 1024) throw new Error('Git blob header is invalid');
      await fill(pending.length + 1);
    }
    const header = pending.subarray(0, newline).toString('ascii');
    pending = pending.subarray(newline + 1);
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob ([0-9]+)$/.exec(header);
    if (!match || match[1] !== oid) throw new Error('Git blob identity is invalid');
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size > 128 * 1024 * 1024) throw new Error('Git blob exceeds the staging limit');
    await fill(size + 1);
    if (pending[size] !== 10) throw new Error('Git blob frame is invalid');
    const value = pending.subarray(0, size);
    pending = pending.subarray(size + 1);
    const actual = createHash(oid.length === 64 ? 'sha256' : 'sha1').update(`blob ${size}\0`).update(value).digest('hex');
    if (actual !== oid) throw new Error('Git blob content does not match the frozen commit');
    return value;
  }
  async function close() { child.stdin.end(); await exit; }
  function abort() { child.stdin.destroy(); child.kill(); }
  return { read, close, abort };
}
function safeName(name) {
  if (!name || /[\\:\0]/.test(name) || isAbsolute(name) || name.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe runtime manifest path');
  }
  return name;
}
export function selectedBy(profile, name) {
  return (profile.files.includes(name) || profile.prefixes.some((prefix) => name.startsWith(prefix)))
    && !profile.exclude.some((excluded) => name === excluded || (excluded.endsWith('/') && name.startsWith(excluded)));
}
export async function stageRuntimePayload({ source, destination, profile: profileName, manifest = manifestPath, sourceMode = 'checkout', windowsBuildDestination }) {
  if (!['checkout', 'git-objects'].includes(sourceMode)) throw new Error('Unknown runtime source mode');
  if (windowsBuildDestination && (sourceMode !== 'git-objects' || profileName !== 'desktop')) {
    throw new Error('Windows build inputs require committed desktop staging');
  }
  source = await realpath(resolve(source));
  destination = resolve(destination);
  const git = async (...args) => (await exec('git', ['--no-optional-locks', ...args],
    { cwd: source, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true })).stdout;
  const head = (await git('rev-parse', 'HEAD')).trim();
  if (sourceMode === 'checkout' && await git('status', '--porcelain=v1', '--untracked-files=all')) {
    throw new Error('Runtime payload requires a clean checkout; preserve local work and build from a frozen checkout');
  }
  const tree = new Map((await git('ls-tree', '-r', '-z', head)).split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, tab).split(' ');
    return [entry.slice(tab + 1), { mode, type, oid }];
  }));
  const reader = sourceMode === 'git-objects' ? createGitBlobReader(source) : null;
  try {
    const manifestObject = tree.get('packaging/runtime-payload.json');
    if (reader && (!manifestObject || manifestObject.type !== 'blob' || !['100644', '100755'].includes(manifestObject.mode))) {
      throw new Error('Committed runtime manifest is missing');
    }
    const manifestBytes = reader ? await reader.read(manifestObject.oid) : await readFile(manifest);
    const spec = JSON.parse(manifestBytes.toString('utf8'));
    const profile = spec.profiles[profileName];
    if (spec.schemaVersion !== 1 || !profile) throw new Error('Unknown runtime payload profile');
    const tracked = [...tree.keys()];
    const selected = tracked.filter((name) => selectedBy(profile, name));
    for (const required of profile.required) {
      if (!selected.includes(required)) throw new Error(`Required runtime input missing: ${required}`);
    }
    await mkdir(destination, { recursive: true });
    if ((await lstat(destination)).isSymbolicLink()) throw new Error('Runtime destination must not be a symlink/reparse point');
    destination = await realpath(destination);
    const sourceRelative = relative(destination, source);
    if (!sourceRelative || (!sourceRelative.startsWith('..') && !isAbsolute(sourceRelative))) {
      throw new Error('Runtime destination must not contain its source checkout');
    }
    if ((await readdir(destination)).length) throw new Error('Runtime destination must be empty');
    const files = [];
    const targets = new Set();
    for (const name of selected.sort()) {
      safeName(name);
      const targetName = safeName(profile.rename[name] || name);
      if (targets.has(targetName.toLowerCase())) throw new Error(`Runtime target collision: ${targetName}`);
      targets.add(targetName.toLowerCase());
      const input = join(source, name);
      const committed = tree.get(name);
      if (committed.type !== 'blob' || !['100644', '100755'].includes(committed.mode)) {
        throw new Error(`Runtime input must be a committed regular file: ${name}`);
      }
      let bytes;
      if (reader) {
        bytes = await reader.read(committed.oid);
      } else {
        let cursor = source;
        for (const component of name.split('/')) {
          cursor = join(cursor, component);
          if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`Runtime input symlink/reparse point: ${name}`);
        }
        if (!(await lstat(input)).isFile()) throw new Error(`Runtime input is not a file: ${name}`);
        bytes = await readFile(input);
      }
      const blobOid = (value) => createHash(committed.oid.length === 64 ? 'sha256' : 'sha1')
        .update(`blob ${value.length}\0`).update(value).digest('hex');
      // status alone can miss assume-unchanged/skip-worktree edits. Verify actual
      // bytes against the frozen commit, allowing Git's ordinary CRLF checkout.
      const normalized = bytes.includes(0) ? bytes : Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'));
      if (blobOid(bytes) !== committed.oid && blobOid(normalized) !== committed.oid) {
        throw new Error(`Runtime input differs from frozen commit: ${name}`);
      }
      const target = join(destination, targetName);
      await mkdir(dirname(target), { recursive: true });
      if (reader) await writeFile(target, bytes, { flag: 'wx' });
      else await copyFile(input, target);
      const copied = await readFile(target);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (createHash('sha256').update(copied).digest('hex') !== sha256) throw new Error(`Input changed while staging: ${name}`);
      files.push({ path: targetName, sha256, bytes: copied.length });
    }
    if (windowsBuildDestination) {
      let buildRoot = resolve(windowsBuildDestination);
      await mkdir(buildRoot, { recursive: true });
      if ((await lstat(buildRoot)).isSymbolicLink()) throw new Error('Windows build destination must not be a symlink/reparse point');
      buildRoot = await realpath(buildRoot);
      const overlaps = (a, b) => { const rel = relative(a, b); return !rel || (!rel.startsWith('..') && !isAbsolute(rel)); };
      if (overlaps(buildRoot, source) || overlaps(source, buildRoot) || overlaps(buildRoot, destination) || overlaps(destination, buildRoot)) {
        throw new Error('Windows build destination must be separate from source and runtime payload');
      }
      if ((await readdir(buildRoot)).length) throw new Error('Windows build destination must be empty');
      const buildFiles = [];
      for (const name of windowsBuildInputs) {
        const committed = tree.get(name);
        if (!committed || committed.type !== 'blob' || !['100644', '100755'].includes(committed.mode)) {
          throw new Error(`Windows build input must be a committed regular file: ${name}`);
        }
        const bytes = await reader.read(committed.oid);
        const target = join(buildRoot, safeName(name));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: 'wx' });
        buildFiles.push({ path: name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
      }
      await writeFile(join(buildRoot, 'windows-build-inputs-manifest.json'), `${JSON.stringify({ schemaVersion: 1, sourceRevision: head, files: buildFiles }, null, 2)}\n`, { flag: 'wx' });
    }
    if ((await git('rev-parse', 'HEAD')).trim() !== head
      || (sourceMode === 'checkout' && await git('status', '--porcelain=v1', '--untracked-files=all'))) {
      throw new Error('Source changed while staging; discard this candidate');
    }
    const scan = await scanRuntimePayload(destination);
    if (!scan.ok) throw new Error(`Runtime payload secret/state check failed: ${JSON.stringify(scan.findings)}`);
    const result = { schemaVersion: 1, profile: profileName, sourceMode, sourceRevision: head,
      allowlistSha256: createHash('sha256').update(manifestBytes).digest('hex'), files };
    await writeFile(join(destination, '.agentoc-source-commit'), `${head}\n`, { flag: 'wx' });
    await writeFile(join(destination, 'runtime-payload-manifest.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    if (reader) await reader.close();
    return result;
  } catch (error) {
    reader?.abort();
    throw error;
  }
}
async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[++index];
    if (!value) throw new Error(`Missing value for ${key}`);
    if (key === '--source') options.source = value;
    else if (key === '--destination') options.destination = value;
    else if (key === '--profile') options.profile = value;
    else if (key === '--source-mode') options.sourceMode = value;
    else if (key === '--windows-build-destination') options.windowsBuildDestination = value;
    else throw new Error(`Unknown option: ${key}`);
  }
  if (!options.source || !options.destination || !options.profile) throw new Error('Usage: stage-runtime-payload.mjs --source <git-repository> --destination <empty-dir> --profile <desktop|accounts> [--source-mode checkout|git-objects]');
  const result = await stageRuntimePayload(options);
  console.log(JSON.stringify({ profile: result.profile, sourceRevision: result.sourceRevision, files: result.files.length }));
}
function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isDirectInvocation()) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

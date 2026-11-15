#!/usr/bin/env node
// P0-C migration helper: relocate the runner-accessible subtrees (the run
// spool root and the provider runtime homes) out of the control CONFIG_DIR to
// the env-targeted runner-owned root.  Once both live outside config, the
// runner group's config traverse ACL can be removed and /var/lib/ragent/config
// becomes fully opaque to Runs.
//
// Relocation happens only when ALL of these hold:
//   - the env target differs from the legacy config location, AND
//   - the legacy dir exists with content, AND
//   - the target is empty or missing (nothing is overwritten)
//
// The helper is idempotent (re-running moves only what is still missing) and
// supports --dry-run.  postinst invokes it after creating the runner user/group
// and before services restart; the unit test exercises it on a temp tree.
//
// Usage:
//   node scripts/relocate-runner-subtrees.mjs [--dry-run] [--owner <user>]
//        [--group <group>]
// Env: RAGENT_CONFIG_DIR (legacy base), RAGENT_RUN_SPOOL_DIR (target spool),
//      RAGENT_PROVIDER_HOMES_DIR (target provider homes).

import { chmod, chown, lstat, mkdir, readdir, rename, rm, rmdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';

const LEGACY_SPOOL = 'chat-runs';
const LEGACY_PROVIDER_HOMES = 'provider-runtime-homes';

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isEmptyDir(path) {
  const entries = await readdir(path);
  return entries.length === 0;
}

// Provider homes are deliberately outside the control-plane config tree, but
// their files still need to be readable by the isolated runner group.  Older
// installs may have copied them with 0600/0640 ownership from the control
// user, so converge the whole subtree during every idempotent migration.
async function convergeRunnerTreePermissions(target, { ownerUid, ownerGid, dryRun, log }) {
  if (dryRun || ownerUid === null || ownerGid === null) return;
  const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await chown(entryPath, ownerUid, ownerGid).catch(() => {});
      await chmod(entryPath, 0o2770).catch(() => {});
      await convergeRunnerTreePermissions(entryPath, { ownerUid, ownerGid, dryRun, log });
      continue;
    }
    const info = await lstat(entryPath).catch(() => null);
    if (!info || !info.isFile()) continue;
    log(`converge runner permissions ${entryPath} (0640)`);
    await chown(entryPath, ownerUid, ownerGid).catch(() => {});
    await chmod(entryPath, 0o640).catch(() => {});
  }
}

// Move one entry from the legacy dir into the target dir.  Never overwrites an
// existing target entry.  Falls back to a copy+delete when the two dirs are on
// different filesystems (rename would throw EXDEV).
async function moveEntry(from, to, { copyImpl, renameImpl }) {
  try {
    await renameImpl(from, to);
    return true;
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await copyImpl(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
    return true;
  }
}

/**
 * Relocate one legacy subtree into its env target.
 *
 * @param {object} pair  { kind, legacy, target }
 * @param {object} opts  { dryRun, ownerUid, ownerGid, log, copyImpl, renameImpl }
 * @returns {Promise<{kind:string, moved:number, created:boolean, removedLegacy:boolean}>}
 */
export async function relocateSubtree(pair, {
  dryRun = false,
  ownerUid = null,
  ownerGid = null,
  log = () => {},
  copyImpl = null,
  renameImpl = rename,
} = {}) {
  const { kind, legacy, target } = pair;
  const result = { kind, moved: 0, created: false, removedLegacy: false };
  if (!target || target === legacy) return result;

  const legacyExists = await pathExists(legacy);
  const targetExists = await pathExists(target);

  if (!targetExists) {
    log(`create ${target} (0770)`);
    result.created = true;
    if (!dryRun) {
      await mkdir(target, { recursive: true, mode: 0o2770 });
      await chmod(target, 0o2770);
      if (ownerUid !== null && ownerGid !== null) {
        try { await chown(target, ownerUid, ownerGid); } catch {}
      }
    }
  }

  if (legacyExists) {
    const entries = await readdir(legacy);
    for (const entry of entries) {
      const from = join(legacy, entry);
      const to = join(target, entry);
      if (await pathExists(to)) continue; // idempotent + partial: never overwrite
      log(`move ${from} -> ${to}`);
      result.moved += 1;
      if (!dryRun) {
        await moveEntry(from, to, { copyImpl, renameImpl });
      }
    }
    if (!dryRun && entries.length > 0 && (await isEmptyDir(legacy))) {
      log(`remove empty legacy dir ${legacy}`);
      result.removedLegacy = true;
      await rmdir(legacy);
    }
  }

  if (!dryRun && ownerUid !== null && ownerGid !== null) {
    try { await chown(target, ownerUid, ownerGid); } catch {}
  }
  if (kind === 'providerHomes') {
    await convergeRunnerTreePermissions(target, { ownerUid, ownerGid, dryRun, log });
  }
  return result;
}

/**
 * Build the (legacy -> target) pairs from the environment.  A pair is only
 * produced when the env target differs from the legacy config location, so
 * dev and pre-migration production are untouched.
 *
 * @param {object} env
 * @param {string} configDir  legacy base (CONFIG_DIR)
 * @returns {Array<{kind:string, legacy:string, target:string}>}
 */
export function resolveSubtreePairs({ env, configDir }) {
  const pairs = [];
  const spoolTarget = resolve(env.RAGENT_RUN_SPOOL_DIR || '');
  const legacySpool = join(configDir, LEGACY_SPOOL);
  if (spoolTarget && spoolTarget !== resolve(legacySpool)) {
    pairs.push({ kind: 'spool', legacy: legacySpool, target: spoolTarget });
  }
  const providerTarget = resolve(env.RAGENT_PROVIDER_HOMES_DIR || '');
  const legacyProvider = join(configDir, LEGACY_PROVIDER_HOMES);
  if (providerTarget && providerTarget !== resolve(legacyProvider)) {
    pairs.push({ kind: 'providerHomes', legacy: legacyProvider, target: providerTarget });
  }
  return pairs;
}

async function main(argv = process.argv.slice(2), {
  env = process.env,
  configDir = env.RAGENT_CONFIG_DIR || join(homedir(), '.config', 'ragent'),
  log = (line) => console.log(line),
} = {}) {
  const dryRun = argv.includes('--dry-run');
  let ownerUid = null;
  let ownerGid = null;
  const ownerIndex = argv.indexOf('--owner');
  const groupIndex = argv.indexOf('--group');
  const ownerName = ownerIndex >= 0 ? argv[ownerIndex + 1] : '';
  const groupName = groupIndex >= 0 ? argv[groupIndex + 1] : '';
  if (ownerName) {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(execFile);
    try {
      ownerUid = Number.parseInt((await exec('id', ['-u', ownerName])).stdout.trim(), 10);
    } catch {
      throw new Error(`cannot resolve owner uid for ${ownerName}`);
    }
  }
  if (groupName) {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(execFile);
    try {
      // `--group` receives a group name from postinst.  `id -g NAME` only
      // resolves users, so use getent for real group names and keep the id
      // fallback for callers that pass a user name in legacy environments.
      const groupEntry = (await exec('getent', ['group', groupName])).stdout.trim();
      ownerGid = Number.parseInt(groupEntry.split(':')[2], 10);
      if (!Number.isInteger(ownerGid)) {
        ownerGid = Number.parseInt((await exec('id', ['-g', groupName])).stdout.trim(), 10);
      }
      if (!Number.isInteger(ownerGid)) throw new Error('invalid group id');
    } catch {
      throw new Error(`cannot resolve group gid for ${groupName}`);
    }
  }

  const pairs = resolveSubtreePairs({ env, configDir });
  if (pairs.length === 0) {
    log('no relocation needed: env targets match the legacy config layout');
    return { pairs: [] };
  }
  const results = [];
  for (const pair of pairs) {
    results.push(await relocateSubtree(pair, { dryRun, ownerUid, ownerGid, log }));
  }
  return { pairs, results };
}

if (process.argv[1] && (await import('node:url')).fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`relocate-runner-subtrees: ${error?.message || String(error)}`);
      process.exit(1);
    });
}

export { main };

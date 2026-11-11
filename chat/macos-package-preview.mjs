/**
 * Read-only, non-authorizing macOS installer artifact preview.
 *
 * This produces diagnostic facts only. Checking paths before and after a read
 * cannot close all rename/symlink races; the eventual privileged executor
 * must independently resolve and operate on a securely opened object. Package
 * signatures, scripts and publisher trust are not established here.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export const MACOS_PACKAGE_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;
const fail = (reason) => ({ ok: false, reason });

function identity(st) {
  return [st.dev, st.ino, st.mode, st.uid, st.gid, st.nlink, st.size, st.mtimeMs, st.ctimeMs].join(':');
}
function validAbsolute(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0')
    && path.posix.normalize(value) === value && !value.split('/').some((part) => part === '.' || part === '..');
}
function strictlyInside(file, root) {
  const rel = path.posix.relative(root, file);
  return Boolean(rel) && rel !== '..' && !rel.startsWith('../') && !path.posix.isAbsolute(rel);
}
async function inspectComponents(file) {
  const segments = file.split('/').filter(Boolean);
  const list = ['/'];
  let current = '';
  for (const segment of segments) { current += `/${segment}`; list.push(current); }
  const snapshots = [];
  for (let i = 0; i < list.length; i += 1) {
    const st = await lstat(list[i]);
    if (st.isSymbolicLink() || (i < list.length - 1 && !st.isDirectory())) throw new Error('unsafe-path');
    snapshots.push(identity(st));
  }
  return snapshots;
}

export async function inspectMacosPackagePreview({ file, projectRoot } = {}) {
  if (!validAbsolute(file) || !validAbsolute(projectRoot) || !strictlyInside(file, projectRoot)
      || !/\.pkg$/i.test(file) || !constants.O_NOFOLLOW) return fail('target:artifact-path-unavailable');
  let handle;
  try {
    // Exact canonical spelling and no symlink ancestors avoid pretending a
    // case-insensitive alias or a symlink is a stable authorization target.
    if (await realpath(projectRoot) !== projectRoot || await realpath(file) !== file) return fail('target:artifact-path-unverified');
    const beforePath = await inspectComponents(file);
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (identity(before) !== beforePath[beforePath.length - 1]) return fail('target:artifact-changed');
    if (!before.isFile() || before.nlink !== 1 || before.size < 0 || before.size > MACOS_PACKAGE_PREVIEW_MAX_BYTES) {
      return fail('target:artifact-type-or-size-unverified');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (bytesRead === 0) return fail('target:artifact-changed');
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    const afterPath = await inspectComponents(file);
    if (identity(before) !== identity(after) || beforePath.join('\n') !== afterPath.join('\n')
        || await realpath(file) !== file) return fail('target:artifact-changed');
    return {
      ok: true,
      artifactPath: file,
      artifactSize: before.size,
      artifactDigest: hash.digest('hex'),
      artifactIdentity: identity(before),
      // These facts are deliberately insufficient to approve execution.
      publisherVerified: false,
      executionRevalidationAvailable: false,
    };
  } catch {
    return fail('target:artifact-unreadable-or-unsafe');
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

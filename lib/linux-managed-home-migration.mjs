// Transfer only an existing managed provider home between verified local
// runner identities. All traversal uses anchored descriptors and never follows
// symlinks, so root cannot be tricked into chowning a path outside the home.
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export async function migrateManagedHomeOwnership(path, { targetUid, targetGid, additionalSourceUid = null } = {}) {
  const fail = () => Object.assign(new Error('Cannot safely migrate managed provider home'), { code:'RUNNER_HOME_MIGRATION_INVALID' });
  const valid = value => Number.isSafeInteger(value) && value > 0 && value <= 0xfffffffe;
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || !isAbsolute(path)
      || !valid(targetUid) || !valid(targetGid)
      || (additionalSourceUid !== null && !valid(additionalSourceUid))) throw fail();
  const parts = resolve(path).split('/').filter(Boolean);
  if (!parts.length) throw fail();
  let directory;
  let count = 0;
  let changed = 0;
  try {
    directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    for (const part of parts) {
      const next = await open(`/proc/self/fd/${directory.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close();
      directory = next;
    }
    const root = await directory.stat();
    if (!root.isDirectory()) throw fail();
    const sources = new Set([root.uid, additionalSourceUid].filter(uid => valid(uid) && uid !== targetUid));
    if (!sources.size) return { changed:0 };
    const visit = async (dir, depth) => {
      if (depth > 100) throw fail();
      const entries = await readdir(`/proc/self/fd/${dir.fd}`, {withFileTypes:true});
      for (const entry of entries) {
        if (++count > 100000) throw fail();
        if (!entry.isDirectory() && !entry.isFile()) continue;
        let child;
        try {
          child = await open(`/proc/self/fd/${dir.fd}/${entry.name}`,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (entry.isDirectory() ? constants.O_DIRECTORY : 0));
          const info = await child.stat();
          if (info.dev !== root.dev || (entry.isDirectory() ? !info.isDirectory() : !info.isFile())) throw fail();
          if (info.isDirectory()) await visit(child, depth + 1);
          else if (info.nlink !== 1) throw fail();
          if (sources.has(info.uid)) {
            await child.chown(targetUid, targetGid);
            if (info.isFile() && (await child.stat()).nlink !== 1) {
              await child.chown(info.uid, info.gid).catch(() => {});
              throw fail();
            }
            if (info.isDirectory()) await child.chmod(info.mode & 0o3777);
            changed++;
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        } finally { await child?.close(); }
      }
    };
    await visit(directory, 0);
    if (sources.has(root.uid)) {
      await directory.chown(targetUid, targetGid);
      await directory.chmod(root.mode & 0o3777);
      changed++;
    }
    return { changed };
  } catch { throw fail(); }
  finally { await directory?.close(); }
}

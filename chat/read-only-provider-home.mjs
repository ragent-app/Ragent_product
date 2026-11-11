import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

const MAX_SEED_BYTES = 2 * 1024 * 1024;
const ROOT = '/tmp/agentoc-reviewer';
const SPECS = {
  codex: { envKey: 'CODEX_HOME', files: ['config.toml', 'auth.json'] },
  claude: { envKey: 'CLAUDE_CONFIG_DIR', files: ['settings.json', '.credentials.json'] },
};
function fail(message) {
  throw Object.assign(new Error(message), { code: 'READ_ONLY_PROVIDER_HOME_UNAVAILABLE' });
}
function readAtStart(fd, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const n = readSync(fd, bytes, offset, size - offset, offset);
    if (!n) fail('Provider credential file changed while preparing the read-only Run');
    offset += n;
  }
  return bytes;
}

/**
 * Snapshot selected provider files in memory for bubblewrap --file. The
 * child receives them through pipes and writes only to its private tmpfs.
 * Native OAuth is refused because rotating a copied refresh token would break
 * the shared provider home. Caller must deliver or erase each returned buffer.
 */
export function openReadOnlyProviderSeeds({ family = '', env = {}, runId = '' } = {}) {
  const spec = SPECS[family];
  const root = spec && typeof env[spec.envKey] === 'string' ? env[spec.envKey].trim() : '';
  const seeds = [];
  const destination = spec ? `${ROOT}/${family}` : '';
  try {
    if (!spec || !root) return { seeds, family: '', destination: '' };
    const runKey = createHash('sha256').update(String(runId)).digest('hex').slice(0, 32);
    const suffix = `/by-run/${runKey}/${family}`;
    if (!runId || !isAbsolute(root) || !root.endsWith(suffix)
        || realpathSync(root) !== root || !constants.O_NOFOLLOW) {
      fail('Provider home is not a stable Run-scoped directory');
    }
    const identities = [];
    for (const name of spec.files) {
      let fd;
      try { fd = openSync(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      let bytes;
      try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.size < 0 || before.size > MAX_SEED_BYTES) fail('Provider configuration cannot be safely copied');
        if (family === 'claude' && name === '.credentials.json') {
          fail('Native Claude credentials are not supported for an isolated read-only Run');
        }
        bytes = readAtStart(fd, before.size);
        const after = fstatSync(fd);
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
          fail('Provider configuration changed while preparing the read-only Run');
        }
        if (family === 'codex' && name === 'auth.json') {
          let auth;
          try { auth = JSON.parse(bytes.toString('utf8')); }
          catch { fail('Codex credentials are not suitable for an isolated read-only Run'); }
          if (!auth || typeof auth !== 'object' || auth.tokens
              || typeof auth.OPENAI_API_KEY !== 'string' || !auth.OPENAI_API_KEY.trim()
              || (auth.auth_mode && !['apikey', 'api_key'].includes(auth.auth_mode))) {
            fail('Native OAuth is not supported for an isolated read-only Run');
          }
        }
        identities.push({ name, dev: before.dev, ino: before.ino, size: before.size,
          mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs });
        seeds.push({ bytes, destination: `${destination}/${name}` });
        bytes = null;
      } finally {
        if (bytes) bytes.fill(0);
        closeSync(fd);
      }
    }
    for (const expected of identities) {
      const current = lstatSync(join(root, expected.name));
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== expected.dev
          || current.ino !== expected.ino || current.size !== expected.size
          || current.mtimeMs !== expected.mtimeMs || current.ctimeMs !== expected.ctimeMs) {
        fail('Provider configuration changed while preparing the read-only Run');
      }
    }
    return { seeds, family, destination };
  } catch (error) {
    for (const seed of seeds) seed.bytes.fill(0);
    if (error?.code === 'READ_ONLY_PROVIDER_HOME_UNAVAILABLE') throw error;
    fail('Provider home cannot be safely prepared for an isolated read-only Run');
  }
}

export function closeReadOnlyProviderSeeds(seedSet) {
  for (const seed of seedSet?.seeds || []) seed.bytes.fill(0);
}

/** Stream immutable snapshots into bwrap's private file-copy descriptors. */
export function deliverReadOnlyProviderSeeds(child, seedSet) {
  for (let index = 0; index < (seedSet?.seeds || []).length; index += 1) {
    const bytes = seedSet.seeds[index].bytes;
    const pipe = child.stdio[index + 3];
    if (!pipe || !pipe.writable) { bytes.fill(0); continue; }
    pipe.once('error', () => bytes.fill(0));
    pipe.end(bytes, () => bytes.fill(0));
  }
}

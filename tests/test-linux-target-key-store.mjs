import assert from 'node:assert/strict';
import { sign, verify } from 'node:crypto';
import { chmod, chown, copyFile, link, lstat, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadLinuxTargetPublicKey, loadOrCreateLinuxTargetKey } from '../chat/linux-target-key-store.mjs';

if (process.platform !== 'linux' || process.geteuid?.() !== 0) throw new Error('requires Linux root');
const root = await mkdtemp('/var/lib/ragent-target-key-test-');
await chmod(root, 0o755);
const directory = `${root}/keys`, privateFile = `${directory}/observation-private.json`, publicFile = `${directory}/observation-public.json`;
try {
  await assert.rejects(loadOrCreateLinuxTargetKey(directory));
  const created = await loadOrCreateLinuxTargetKey(directory, { initialize: true });
  const again = await loadOrCreateLinuxTargetKey(directory);
  assert.equal(created.keyId, again.keyId);
  assert.equal((await lstat(privateFile)).mode & 0o7777, 0o600);
  assert.equal((await lstat(publicFile)).mode & 0o7777, 0o644);
  const publicData = await readFile(publicFile), privateData = await readFile(privateFile);
  const trusted = await loadLinuxTargetPublicKey(directory);
  const message = Buffer.from('isolated target key test');
  assert.equal(verify(null, message, trusted.publicKey, sign(null, message, created.privateKey)), true);

  // A different unprivileged user can read the public key but not the private key.
  const copiedModule = `${root}/key-store.mjs`;
  await copyFile(new URL('../chat/linux-target-key-store.mjs', import.meta.url), copiedModule);
  await chmod(copiedModule, 0o644);
  const script = `import {loadLinuxTargetPublicKey} from ${JSON.stringify(pathToFileURL(copiedModule).href)};
import {readFile} from 'node:fs/promises';
import {writeFile} from 'node:fs/promises';
await loadLinuxTargetPublicKey(process.argv[1]);
try { await readFile(process.argv[1] + '/observation-private.json'); process.exit(2); }
catch (e) { if (e.code !== 'EACCES') process.exit(3); }
try { await writeFile(process.argv[1] + '/observation-public.json', 'tampered'); process.exit(4); }
catch (e) { if (e.code !== 'EACCES') process.exit(5); }
process.stdout.write('public-only');`;
  const otherUser = spawnSync(process.execPath, ['--input-type=module', '-e', script, directory], { uid: 65534, gid: 65534, encoding: 'utf8' });
  assert.equal(otherUser.status, 0, otherUser.stderr);
  assert.equal(otherUser.stdout, 'public-only');

  await chmod(publicFile, 0o666);
  await assert.rejects(loadLinuxTargetPublicKey(directory));
  await chmod(publicFile, 0o644);
  await chmod(privateFile, 0o644);
  await assert.rejects(loadOrCreateLinuxTargetKey(directory));
  await chmod(privateFile, 0o600);
  await chown(publicFile, 65534, 65534);
  await assert.rejects(loadLinuxTargetPublicKey(directory));
  await chown(publicFile, 0, 0);
  await chown(privateFile, 65534, 65534);
  await assert.rejects(loadOrCreateLinuxTargetKey(directory));
  await chown(privateFile, 0, 0);
  await link(privateFile, `${root}/private-link`);
  await assert.rejects(loadOrCreateLinuxTargetKey(directory));
  await unlink(`${root}/private-link`);
  await rename(publicFile, `${root}/saved-public`);
  await symlink(`${root}/saved-public`, publicFile);
  await assert.rejects(loadLinuxTargetPublicKey(directory));
  await unlink(publicFile);
  await rename(`${root}/saved-public`, publicFile);
  await symlink(directory, `${root}/alias`);
  await assert.rejects(loadLinuxTargetPublicKey(`${root}/alias`));
  await chmod(root, 0o777);
  await assert.rejects(loadLinuxTargetPublicKey(directory));
  await chmod(root, 0o755);

  await writeFile(privateFile, '{}\n');
  await assert.rejects(loadOrCreateLinuxTargetKey(directory));
  await writeFile(privateFile, privateData);
  await writeFile(publicFile, '{}\n');
  await assert.rejects(loadLinuxTargetPublicKey(directory));
  await writeFile(publicFile, publicData);
  await rename(privateFile, `${root}/saved-private`);
  await assert.rejects(loadOrCreateLinuxTargetKey(directory));
  await assert.rejects(loadOrCreateLinuxTargetKey(directory, { initialize: true }));
  await rename(`${root}/saved-private`, privateFile);
  await unlink(publicFile);
  assert.equal((await loadOrCreateLinuxTargetKey(directory)).keyId, created.keyId);
  assert.equal((await loadLinuxTargetPublicKey(directory)).keyId, created.keyId);
  await unlink(publicFile);
  await unlink(privateFile);
  await assert.rejects(loadOrCreateLinuxTargetKey(directory));
  assert.notEqual((await loadOrCreateLinuxTargetKey(directory, { initialize: true })).keyId, created.keyId);
  console.log('linux target key store: protected key checks passed');
} finally {
  await chmod(root, 0o755);
  await rm(root, { recursive: true });
}

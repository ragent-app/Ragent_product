import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { enrollLinuxServiceKeyPin, loadLinuxServiceKeyPin } from '../scripts/linux-service-key-pin.mjs';

test('root pin requires authenticated fingerprint, refuses replacement and unsafe files', { skip: process.platform !== 'linux' || process.geteuid?.() !== 0 }, async () => {
  const directory = await mkdtemp('/srv/agentoc-pin-test-');
  const filename = `${directory}/service-scope-public.json`;
  try {
    const { publicKey } = generateKeyPairSync('ed25519');
    const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    await assert.rejects(enrollLinuxServiceKeyPin({ directory, publicKey, expectedKeyId: '0'.repeat(64) }));
    await assert.rejects(loadLinuxServiceKeyPin(directory));
    assert.equal((await enrollLinuxServiceKeyPin({ directory, publicKey, expectedKeyId: keyId })).keyId, keyId);
    assert.equal((await loadLinuxServiceKeyPin(directory)).keyId, keyId);
    await assert.rejects(enrollLinuxServiceKeyPin({ directory, publicKey, expectedKeyId: keyId }));
    const saved = await readFile(filename, 'utf8');
    await chmod(filename, 0o666);
    await assert.rejects(loadLinuxServiceKeyPin(directory));
    await chmod(filename, 0o600);
    await writeFile(filename, saved.replace(keyId, '0'.repeat(64)));
    await assert.rejects(loadLinuxServiceKeyPin(directory));
    await rm(filename);
    await symlink('/etc/passwd', filename);
    await assert.rejects(loadLinuxServiceKeyPin(directory));
    await chmod(directory, 0o777);
    await assert.rejects(loadLinuxServiceKeyPin(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('non-root cannot enroll or load a pin', { skip: process.platform !== 'linux' || process.geteuid?.() === 0 }, async () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  await assert.rejects(enrollLinuxServiceKeyPin({ directory: '/srv/nonexistent', publicKey, expectedKeyId: '0'.repeat(64) }));
  await assert.rejects(loadLinuxServiceKeyPin('/srv/nonexistent'));
});

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWindowsAutoInstallPublicIdentity, loadWindowsAutoInstallSigningKey } from '../chat/windows-managed-auto-install.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-instance-signer-'));
const path = join(root, 'identity.json');
try {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const instanceId = `inst_${fingerprint.slice(0, 32)}`;
  await writeFile(path, JSON.stringify({ version: 1, algorithm: 'ed25519', instanceId,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }), { mode: 0o600 });
  const key = await loadWindowsAutoInstallSigningKey({ filePath: path });
  const publicIdentity = await loadWindowsAutoInstallPublicIdentity({ filePath: path });
  assert.deepEqual(Object.keys(publicIdentity).sort(), ['kid', 'publicKey']);
  assert.equal(publicIdentity.kid, instanceId);
  assert.equal(publicIdentity.publicKey, publicKey.export({ type: 'spki', format: 'pem' }).toString());
  assert.equal(key.kid, instanceId);
  const message = Buffer.from('isolated test');
  assert(verify(null, message, publicKey, sign(null, message, key.privateKey)));
  assert.equal(await loadWindowsAutoInstallSigningKey({ filePath: join(root, 'missing.json') }), null);
  assert.equal(await loadWindowsAutoInstallPublicIdentity({ filePath: join(root, 'missing.json') }), null);
} finally { await unlink(path).catch(() => {}); await rmdir(root).catch(() => {}); }
console.log('windows-instance-signing-key: existing identity and key binding passed');

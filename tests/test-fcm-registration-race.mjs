import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'ragent-fcm-registration-'));
const file = join(dir, 'tokens.json');
const previous = process.env.RAGENT_FCM_TOKENS_FILE;
process.env.RAGENT_FCM_TOKENS_FILE = file;
try {
  const { registerFcmToken, unregisterFcmToken, removeRejectedFcmTokens } = await import('../chat/fcm.mjs');
  await registerFcmToken({ token: 'old-a', deviceId: 'phone-a' });
  await registerFcmToken({ token: 'old-c', deviceId: 'phone-c' });
  await registerFcmToken({ token: 'bad-d', deviceId: 'phone-d' });
  // A provider request is holding these old tokens while the owner rotates,
  // adds another phone and removes one registration. Cleanup must use live data.
  const snapshot = JSON.parse(await readFile(file, 'utf8'));
  await Promise.all([
    registerFcmToken({ token: 'new-a', deviceId: 'phone-a' }),
    registerFcmToken({ token: 'new-b', deviceId: 'phone-b' }),
    unregisterFcmToken('old-c'),
  ]);
  await removeRejectedFcmTokens(snapshot.map(record => record.token));
  const records = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(records.find(record => record.deviceId === 'phone-a')?.token, 'new-a');
  assert.equal(records.find(record => record.deviceId === 'phone-b')?.token, 'new-b');
  assert.ok(!records.some(record => record.deviceId === 'phone-c'));
  assert.ok(!records.some(record => record.deviceId === 'phone-d'));
  console.log('test-fcm-registration-race: 4 assertions passed');
} finally {
  if (previous === undefined) delete process.env.RAGENT_FCM_TOKENS_FILE;
  else process.env.RAGENT_FCM_TOKENS_FILE = previous;
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.ok(basename(dir).startsWith('ragent-fcm-registration-'));
  await rm(dir, { recursive: true, force: true });
}

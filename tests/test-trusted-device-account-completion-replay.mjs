#!/usr/bin/env node
// Each case runs in a fresh process and owns only its temporary config root.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cases = ['replay', 'superseded', 'overlap-expiry', 'revoked', 'legacy', 'expired', 'coexisting'];
const selected = process.argv[2];
if (!selected) {
  let failed = 0;
  for (const name of cases) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], {
      encoding: 'utf8', windowsHide: true, timeout: 20_000,
    });
    process.stdout.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    if (child.status !== 0) failed++;
  }
  console.log(`Account completion replay: ${cases.length - failed}/${cases.length} passed`);
  process.exitCode = failed ? 1 : 0;
} else {
  assert(cases.includes(selected), 'Unknown fixture case');
  const root = mkdtempSync(join(tmpdir(), 'ragent-completion-replay-'));
  const configRoot = join(root, 'config');
  process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
  process.env.RAGENT_CONFIG_DIR = configRoot;
  delete process.env.RAGENT_INSTANCE_ROOT;
  mkdirSync(configRoot);
  const file = join(configRoot, 'trusted-devices.json');
  const NativeDate = Date;
  let instant = NativeDate.UTC(2026, 9, 25, 0, 0, 0);
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return instant; }
  };
  try {
    const { TRUSTED_DEVICES_FILE } = await import('../lib/config.mjs');
    assert(resolve(TRUSTED_DEVICES_FILE) === resolve(file), 'Fixture must use only its own config');
    const api = await import('../chat/trusted-devices.mjs');
    const { createDevicePublicKeyFingerprint } = await import('../lib/device-auth-protocol.mjs');
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey
      .export({ type: 'spki', format: 'pem' }).toString();
    const deviceId = 'rdev_completion_fixture';
    const accountId = 'acct_completion_fixture';
    writeFileSync(file, JSON.stringify({
      version: 1, instanceId: 'rli_completion_fixture', instanceSecret: 'synthetic-completion-fixture-secret',
      devices: [], authTokens: [], invitations: [], challenges: [], accountJoinIntents: [],
    }));
    const read = () => JSON.parse(readFileSync(file, 'utf8'));
    function complete(id) {
      return api.completeTrustedDeviceAccountIntent({
        intentId: id, accountId, requestId: `request_${id}`, verifiedAccountCompletion: true,
        deviceSignature: 'synthetic-already-verified-by-accounts',
        intent: {
          intentId: id, deviceId, devicePublicKey: key,
          devicePublicKeyFingerprint: createDevicePublicKeyFingerprint(key),
          deviceName: 'Synthetic phone', platform: 'android',
          // Keep this fixture's intent alive beyond the credential deadline
          // so expiry checks cannot be satisfied by the intent's earlier TTL.
          expiresAt: new Date(instant + 30 * 60_000).toISOString(),
        },
      });
    }
    const first = await complete('rji_first');
    assert(await api.authenticateTrustedDeviceToken(first.credential.token), 'First credential must authenticate');
    if (selected === 'replay') {
      instant += 10_000;
      const before = readFileSync(file, 'utf8');
      const replies = await Promise.all([complete('rji_first'), complete('rji_first'), complete('rji_first')]);
      assert(replies.every(r => r.credential.token === first.credential.token), 'A repeated completion must return the exact issued credential');
      assert(replies.every(r => r.credential.expiresAt === first.credential.expiresAt), 'Replays must not extend the credential deadline');
      assert(readFileSync(file, 'utf8') === before, 'Replay must preserve all persisted state');
      assert(await api.authenticateTrustedDeviceToken(first.credential.token), 'The cached first response must remain valid');
      const restart = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import {readFileSync} from 'node:fs';
        import {createHash} from 'node:crypto';
        const NativeDate = Date;
        globalThis.Date = class extends NativeDate {
          constructor(...args) { super(...(args.length ? args : [${instant}])); }
          static now() { return ${instant}; }
        };
        const {TRUSTED_DEVICES_FILE} = await import(${JSON.stringify(new URL('../lib/config.mjs', import.meta.url).href)});
        const {completeTrustedDeviceAccountIntent} = await import(${JSON.stringify(new URL('../chat/trusted-devices.mjs', import.meta.url).href)});
        const before = readFileSync(TRUSTED_DEVICES_FILE, 'utf8');
        const state = JSON.parse(before), intent = state.accountJoinIntents[0];
        const result = await completeTrustedDeviceAccountIntent({intentId: intent.intentId,
          accountId: intent.accountId, requestId: intent.completionRequestId, verifiedAccountCompletion: true});
        assert(createHash('sha256').update(result.credential.token).digest('hex') === state.authTokens[0].tokenHash,
          'Restart must reproduce the persisted credential, without rotating it');
        assert(result.credential.expiresAt === state.authTokens[0].expiresAt, 'Restart must retain the original deadline');
        assert(readFileSync(TRUSTED_DEVICES_FILE, 'utf8') === before, 'Restart replay must preserve persisted state');
      `], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      if (restart.status !== 0) process.stderr.write(restart.stderr || 'Restart child failed\n');
      assert(restart.status === 0, 'Replay must survive a real process restart');
    } else if (selected === 'superseded') {
      instant += 10_000;
      const second = await complete('rji_second');
      assert(second.credential.token !== first.credential.token, 'A fresh join must replace the old credential');
      assert(await api.authenticateTrustedDeviceToken(second.credential.token), 'New generation must authenticate');
      assert(await api.authenticateTrustedDeviceToken(first.credential.token), 'Same-device renewal allows the old carrier a bounded overlap');
      const before = readFileSync(file, 'utf8');
      await assert.rejects(() => complete('rji_first'), e => e?.code === 'owner_auth_native_replay');
      assert(readFileSync(file, 'utf8') === before, 'An old completion must not mutate the replacement generation');
      assert(await api.authenticateTrustedDeviceToken(second.credential.token), 'Old replay must preserve the replacement credential');
      instant += 30_000;
      await complete('rji_third');
      instant += 30_000;
      assert(!await api.authenticateTrustedDeviceToken(first.credential.token), 'Further renewal must not extend an existing overlap');
      assert(await api.authenticateTrustedDeviceToken(second.credential.token), 'Newer overlap retains its own deadline');
      await api.revokeTrustedDevice(deviceId);
      assert(!await api.authenticateTrustedDeviceToken(second.credential.token), 'Revocation immediately invalidates overlap');
    } else if (selected === 'overlap-expiry') {
      instant += 14 * 60_000 + 59_000;
      const next = await complete('rji_near_expiry');
      assert(await api.authenticateTrustedDeviceToken(first.credential.token));
      instant += 1_000;
      assert(!await api.authenticateTrustedDeviceToken(first.credential.token), 'Overlap cannot extend the original token expiration');
      assert(await api.authenticateTrustedDeviceToken(next.credential.token));
    } else if (selected === 'revoked') {
      await api.revokeTrustedDevice(deviceId);
      const before = readFileSync(file, 'utf8');
      await assert.rejects(() => complete('rji_first'), e => e?.code === 'owner_auth_native_replay');
      assert(readFileSync(file, 'utf8') === before, 'Replay must not resurrect a revoked device');
      const fresh = await complete('rji_fresh_authorized');
      assert(await api.authenticateTrustedDeviceToken(fresh.credential.token), 'A fresh verified join can enroll again');
      assert(!await api.authenticateTrustedDeviceToken(first.credential.token), 'Re-enrollment must not revive the first credential');
    } else if (selected === 'legacy') {
      const state = read();
      for (const k of Object.keys(state.accountJoinIntents[0])) {
        if (k.startsWith('completionCredential')) delete state.accountJoinIntents[0][k];
      }
      writeFileSync(file, JSON.stringify(state));
      const before = readFileSync(file, 'utf8');
      await assert.rejects(() => complete('rji_first'), e => e?.code === 'owner_auth_native_replay');
      assert(readFileSync(file, 'utf8') === before, 'Unrecoverable legacy random credentials must not be rotated by replay');
      assert(await api.authenticateTrustedDeviceToken(first.credential.token), 'Legacy migration must preserve an active credential');
    } else if (selected === 'expired') {
      instant += 15 * 60_000;
      assert(!await api.authenticateTrustedDeviceToken(first.credential.token), 'Credential expires at the original boundary');
      const before = readFileSync(file, 'utf8');
      await assert.rejects(() => complete('rji_first'), e => e?.code === 'owner_auth_native_replay');
      assert(readFileSync(file, 'utf8') === before, 'Expired credential must not be reissued by replay');
    } else {
      const sibling = await api.issueTrustedDeviceCredential(deviceId);
      const before = readFileSync(file, 'utf8');
      const replay = await complete('rji_first');
      assert(replay.credential.token === first.credential.token, 'A separately issued credential must not change the original replay');
      assert(readFileSync(file, 'utf8') === before, 'Replay must not remove a separately authorized credential');
      assert(await api.authenticateTrustedDeviceToken(sibling.token), 'Separately issued credential must remain valid');
    }
    console.log(`ok - account completion ${selected}`);
  } finally {
    globalThis.Date = NativeDate;
    assert(dirname(resolve(root)) === resolve(tmpdir()) && basename(root).startsWith('ragent-completion-replay-'), 'Cleanup must remain in the owned temporary root');
    rmSync(root, { recursive: true, force: true });
  }
}

#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = mkdtempSync(join(tmpdir(), 'ragent-external-codex-oauth-'));
const configDir = join(root, 'config');
const externalAuthFile = join(root, 'codex', 'auth.json');
mkdirSync(join(root, 'codex'), { recursive: true });
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_EXTERNAL_CODEX_AUTH_FILE = externalAuthFile;
process.env.RAGENT_CODEX_EXTERNAL_OAUTH_HANDOFF_POLICY = 'explicit';

const { runExternalCodexOAuthCommand } = await import('../lib/external-codex-oauth-command.mjs');

function capture() {
  let value = '';
  return {
    write(chunk) { value += String(chunk); },
    text() { return value; },
  };
}

function writeExternalAccount(accountId, accessToken, refreshToken) {
  writeFileSync(externalAuthFile, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { account_id: accountId, access_token: accessToken, refresh_token: refreshToken },
  }) + '\n');
}

try {
  writeExternalAccount('account-a', 'at-a', 'rt-a');
  const initialOut = capture();
  assert.equal(await runExternalCodexOAuthCommand(['status', '--json'], { stdout: initialOut }), 0);
  const initial = JSON.parse(initialOut.text());
  assert.equal(initial.external.status, 'logged-in');
  assert.equal(initial.external.accountId, 'account-a');
  assert.equal(initial.ownership.records[0].status, 'external-owned');
  assert.doesNotMatch(initialOut.text(), /rt-a|at-a/);

  writeExternalAccount('account-b', 'at-b', 'rt-b');
  const switchedOut = capture();
  assert.equal(await runExternalCodexOAuthCommand(['status', '--json'], { stdout: switchedOut }), 0);
  const switched = JSON.parse(switchedOut.text());
  assert.equal(switched.external.accountId, 'account-b');
  assert.equal(switched.ownership.records.find((row) => row.accountId === 'account-a').status, 'handoff-pending');

  const takeoverOut = capture();
  assert.equal(await runExternalCodexOAuthCommand(['takeover', '--account', 'account-a', '--json'], { stdout: takeoverOut }), 0);
  const takeover = JSON.parse(takeoverOut.text());
  assert.equal(takeover.ownership.records.find((row) => row.accountId === 'account-a').status, 'ragent-owned');

  await assert.rejects(
    () => runExternalCodexOAuthCommand(['takeover', '--account', 'account-b'], { stdout: capture() }),
    /still owns this account/,
  );

  writeExternalAccount('account-a', 'at-a-2', 'rt-a-2');
  const reloginOut = capture();
  assert.equal(await runExternalCodexOAuthCommand(['status', '--json'], { stdout: reloginOut }), 0);
  const relogin = JSON.parse(reloginOut.text());
  assert.equal(relogin.external.accountId, 'account-a');
  assert.equal(relogin.ownership.records.find((row) => row.accountId === 'account-a').status, 'external-owned');
  assert.equal(readFileSync(join(configDir, 'native-provider-runtime', 'external-codex-ownership.json'), 'utf8').includes('rt-a-2'), false);
  console.log('test-external-codex-oauth-command: ownership transitions and takeover passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}

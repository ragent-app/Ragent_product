#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = mkdtempSync(join(tmpdir(), 'ragent-external-claude-oauth-'));
const configDir = join(root, 'config');
const credentialsFile = join(root, 'claude', '.credentials.json');
mkdirSync(join(root, 'claude'), { recursive: true });
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_EXTERNAL_CLAUDE_CREDENTIALS_FILE = credentialsFile;

const { runExternalClaudeOAuthCommand } = await import('../lib/external-claude-oauth-command.mjs');

function capture() {
  let value = '';
  return {
    write(chunk) { value += String(chunk); },
    text() { return value; },
  };
}

function writeExternalAccount(accessToken, refreshToken) {
  writeFileSync(credentialsFile, JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken, expiresAt: 100 },
  }) + '\n');
}

try {
  writeExternalAccount('claude-at-a', 'claude-rt-a');
  const initialOut = capture();
  assert.equal(await runExternalClaudeOAuthCommand(['status', '--json'], { stdout: initialOut }), 0);
  const initial = JSON.parse(initialOut.text());
  assert.equal(initial.external.status, 'logged-in');
  assert.match(initial.external.ownershipKey, /^refresh:[0-9a-f]{16}$/);
  assert.equal(initial.ownership.records[0].status, 'external-owned');
  assert.doesNotMatch(initialOut.text(), /claude-rt-a|claude-at-a/);

  writeExternalAccount('claude-at-b', 'claude-rt-b');
  const switchedOut = capture();
  assert.equal(await runExternalClaudeOAuthCommand(['status', '--json'], { stdout: switchedOut }), 0);
  const switched = JSON.parse(switchedOut.text());
  assert.equal(switched.ownership.records.find((row) => row.accountId === initial.external.ownershipKey).status, 'handoff-pending');

  const takeoverOut = capture();
  assert.equal(await runExternalClaudeOAuthCommand([
    'takeover', '--account', initial.external.ownershipKey, '--json',
  ], { stdout: takeoverOut }), 0);
  const takeover = JSON.parse(takeoverOut.text());
  assert.equal(takeover.ownership.records.find((row) => row.accountId === initial.external.ownershipKey).status, 'ragent-owned');

  await assert.rejects(
    () => runExternalClaudeOAuthCommand(['takeover', '--account', switched.ownership.currentExternalAccountId], { stdout: capture() }),
    /still owns this account/,
  );

  writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: {} }) + '\n');
  const logoutOut = capture();
  assert.equal(await runExternalClaudeOAuthCommand(['status', '--json'], { stdout: logoutOut }), 0);
  const loggedOut = JSON.parse(logoutOut.text());
  assert.equal(loggedOut.external.status, 'logged-out');
  assert.doesNotMatch(readFileSync(join(configDir, 'native-provider-runtime', 'external-claude-ownership.json'), 'utf8'), /claude-rt-a|claude-rt-b|claude-at-a|claude-at-b/);
  console.log('test-external-claude-oauth-command: ownership transitions and takeover passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}

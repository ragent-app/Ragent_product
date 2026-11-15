#!/usr/bin/env node
// Gmail + Drive connectors: binding materialization (connector-bindings)
// and status reporting (connector-gmail / connector-drive) against a
// throwaway config home. Google API calls themselves are not exercised —
// status and binding state are file-derived and API-independent.

import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-gmail-drive-'));
process.env.HOME = tempHome;
delete process.env.RAGENT_INSTANCE_ROOT;
delete process.env.RAGENT_CONFIG_DIR;
delete process.env.RAGENT_PUBLIC_BASE_URL;

const connectorDir = join(tempHome, '.config', 'ragent', 'calendar-connector');
const credentialsPath = join(connectorDir, 'google-oauth-client.json');
const tokenPath = join(connectorDir, 'google-calendar-token.json');
mkdirSync(connectorDir, { recursive: true });
writeFileSync(credentialsPath, JSON.stringify({
  web: {
    client_id: 'test-client-id',
    client_secret: 'test-client-secret',
    redirect_uris: ['https://agentoc.example.test/api/connectors/calendar/google/callback'],
  },
}), 'utf8');

const FULL_TOKEN = JSON.stringify({
  access_token: 'test-access-token',
  refresh_token: 'test-refresh-token',
  scope: 'https://www.googleapis.com/auth/calendar'
    + ' https://www.googleapis.com/auth/gmail.readonly'
    + ' https://www.googleapis.com/auth/gmail.send'
    + ' https://www.googleapis.com/auth/drive.file',
  token_type: 'Bearer',
  expiry_date: Date.now() + 3600 * 1000,
});
const CALENDAR_ONLY_TOKEN = JSON.stringify({
  access_token: 'stale-access-token',
  refresh_token: 'stale-refresh-token',
  scope: 'https://www.googleapis.com/auth/calendar',
  token_type: 'Bearer',
});

const {
  ensureGoogleConnectorBinding,
  ensureCalendarConnectorBinding,
  listConnectorBindings,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'connector-bindings.mjs')).href);
const { getGmailStatus } = await import(pathToFileURL(join(repoRoot, 'lib', 'connector-gmail.mjs')).href);
const { getDriveStatus } = await import(pathToFileURL(join(repoRoot, 'lib', 'connector-drive.mjs')).href);

const DEFAULT_GMAIL_BINDING_ID = 'binding_gmail_google';
const DEFAULT_DRIVE_BINDING_ID = 'binding_drive_google';

let passed = 0;
function check(name, condition, detail = '') {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`ok - ${name}`);
}

async function run() {
  // --- ensureGoogleConnectorBinding rejects unknown connectors ---
  await assert.rejects(
    () => ensureGoogleConnectorBinding({ connectorId: 'sheets' }),
    /requires connectorId "gmail" or "drive"/,
  );
  passed += 1;
  console.log('ok - ensureGoogleConnectorBinding rejects unknown connector');

  // --- materialize with no token file: authorization_required ---
  const gmailBinding = await ensureGoogleConnectorBinding({
    connectorId: 'gmail',
    bindingId: DEFAULT_GMAIL_BINDING_ID,
    provider: 'google',
    accountHint: 'Google Gmail',
    tokenPath,
    title: 'Google Gmail',
  });
  check('gmail binding materialized with fixed id', gmailBinding.id === DEFAULT_GMAIL_BINDING_ID);
  check('gmail binding awaiting authorization', gmailBinding.capabilityState === 'authorization_required');
  check('gmail binding keeps token path', gmailBinding.tokenPath === tokenPath);

  const driveBinding = await ensureGoogleConnectorBinding({
    connectorId: 'drive',
    bindingId: DEFAULT_DRIVE_BINDING_ID,
    provider: 'google',
    accountHint: 'Google Drive',
    tokenPath,
    title: 'Google Drive',
  });
  check('drive binding materialized with fixed id', driveBinding.id === DEFAULT_DRIVE_BINDING_ID);
  check('drive binding awaiting authorization', driveBinding.capabilityState === 'authorization_required');

  // --- status without token ---
  let status = await getGmailStatus({
    binding: gmailBinding,
    credentialsPath,
    tokenPath,
  });
  check('gmail status sees credentials', status.credentialsPresent === true);
  check('gmail status sees no token', status.tokenPresent === false);
  check('gmail status awaiting authorization', status.capabilityState === 'authorization_required');
  check('gmail status exposes account hint', status.accountHint === 'Google Gmail');

  // --- token present with full scopes: ready + compliant ---
  writeFileSync(tokenPath, FULL_TOKEN, 'utf8');
  status = await getGmailStatus({ binding: gmailBinding, credentialsPath, tokenPath });
  check('gmail ready with full-scope token', status.tokenPresent === true && status.scopeCompliant === true);
  check('gmail capabilityState ready', status.capabilityState === 'ready');

  const driveStatus = await getDriveStatus({ binding: driveBinding, credentialsPath, tokenPath });
  check('drive ready with full-scope token', driveStatus.tokenPresent === true && driveStatus.scopeCompliant === true);
  check('drive capabilityState ready', driveStatus.capabilityState === 'ready');

  // --- stale token (calendar-only scope): present but not compliant ---
  writeFileSync(tokenPath, CALENDAR_ONLY_TOKEN, 'utf8');
  status = await getGmailStatus({ binding: gmailBinding, credentialsPath, tokenPath });
  check('gmail detects stale scope', status.tokenPresent === true && status.scopeCompliant === false);
  check('gmail re-auth required on stale scope', status.capabilityState === 'authorization_required');
  const staleDriveStatus = await getDriveStatus({ binding: driveBinding, credentialsPath, tokenPath });
  check('drive detects stale scope', staleDriveStatus.scopeCompliant === false);

  // --- listConnectorBindings includes gmail + drive materialized entries ---
  writeFileSync(tokenPath, FULL_TOKEN, 'utf8');
  const bindings = await listConnectorBindings();
  const gmailEntry = bindings.find((binding) => binding.connectorId === 'gmail');
  const driveEntry = bindings.find((binding) => binding.connectorId === 'drive');
  check('bindings list contains gmail', !!gmailEntry && gmailEntry.capabilityState === 'ready');
  check('bindings list contains drive', !!driveEntry && driveEntry.capabilityState === 'ready');

  // --- ensure is idempotent: second ensure keeps the same record ---
  const again = await ensureGoogleConnectorBinding({
    connectorId: 'gmail',
    bindingId: DEFAULT_GMAIL_BINDING_ID,
    provider: 'google',
    accountHint: 'Google Gmail',
    tokenPath,
    title: 'Google Gmail',
  });
  check('ensure is idempotent', again.id === DEFAULT_GMAIL_BINDING_ID && again.capabilityState === 'ready');
  const countAfter = (await listConnectorBindings()).filter((binding) => binding.connectorId === 'gmail');
  check('no duplicate gmail binding', countAfter.length === 1);

  // --- calendar binding still materializes alongside (shared token path) ---
  const calendarBinding = await ensureCalendarConnectorBinding({
    bindingId: 'binding_calendar_test',
    provider: 'google',
    accountHint: 'Google Calendar',
    tokenPath,
    title: 'Google Calendar',
  });
  check('calendar binding ready with shared token', calendarBinding.capabilityState === 'ready');

  console.log(`\n${passed} checks passed`);
  rmSync(tempHome, { recursive: true, force: true });
}

run().catch((error) => {
  console.error(error);
  rmSync(tempHome, { recursive: true, force: true });
  process.exit(1);
});

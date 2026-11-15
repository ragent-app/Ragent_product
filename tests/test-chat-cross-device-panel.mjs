#!/usr/bin/env node
// Focused browser contract for the new cross-device MD3 workspace.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import * as ZXing from '@zxing/library';
import { TEMPORARY_CONTROL_CAPABILITIES } from '../lib/temporary-control-policy.mjs';

const zxing = ZXing.default || ZXing;

async function decodeQrCanvas(canvasLocator) {
  const pixels = await canvasLocator.evaluate((canvas) => {
    const { width, height } = canvas;
    const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const luminance = new Array(width * height);
    for (let pixel = 0, source = 0; pixel < luminance.length; pixel += 1, source += 4) {
      luminance[pixel] = Math.round((rgba[source] * 306 + rgba[source + 1] * 601 + rgba[source + 2] * 117) / 1024);
    }
    return { width, height, luminance };
  });
  const source = new zxing.RGBLuminanceSource(new Uint8ClampedArray(pixels.luminance), pixels.width, pixels.height);
  const bitmap = new zxing.BinaryBitmap(new zxing.HybridBinarizer(source));
  return new zxing.QRCodeReader().decode(bitmap).getText();
}

const repoRoot = new URL('../', import.meta.url);
const temporaryPairingFixture = JSON.parse(await readFile(
  new URL('android/core/protocol/src/test/resources/fixtures/temporary-pairing-signed.json', repoRoot), 'utf8'));
const temporaryInvitation = temporaryPairingFixture.envelope.invitation;
delete temporaryInvitation.accessExpiresAt;
temporaryInvitation.accessDurationMs = 600_000;
temporaryInvitation.sessionScope = 'all-workbench';
temporaryInvitation.capabilities = [...TEMPORARY_CONTROL_CAPABILITIES];
const [tokens, components, panelStyles, icons, qrCreator, panelSource] = await Promise.all([
  readFile(new URL('static/chat/chat-m3-tokens.css', repoRoot), 'utf8'),
  readFile(new URL('static/chat/chat-m3-components.css', repoRoot), 'utf8'),
  readFile(new URL('static/chat/cross-device-panel.css', repoRoot), 'utf8'),
  readFile(new URL('static/chat/icons.js', repoRoot), 'utf8'),
  readFile(new URL('static/qr-creator.min.js', repoRoot), 'utf8'),
  readFile(new URL('static/chat/cross-device-panel.js', repoRoot), 'utf8'),
]);
const reviewDir = process.env.RAGENT_VISUAL_REVIEW_DIR
  || '/var/lib/ragent/workspace/visual-ui-reviews/cross-device-panel';
await mkdir(reviewDir, { recursive: true });

const markup = `<!doctype html><html lang="en"><head><meta charset="utf-8"><base href="http://localhost/"></head><body>
  <button id="launch" type="button">Open</button>
  <div class="cross-device-overlay" id="crossDeviceOverlay" hidden>
    <div class="cross-device-backdrop" data-cross-device-close="true"></div>
    <section class="cross-device-sheet" id="crossDeviceSheet" role="dialog" aria-modal="true" aria-labelledby="crossDeviceTitle" aria-describedby="crossDeviceDescription" tabindex="-1">
      <header class="cross-device-header">
        <div class="cross-device-title-block">
          <span class="cross-device-eyebrow">Device workspace</span>
          <h2 id="crossDeviceTitle">Connect devices</h2>
          <p id="crossDeviceDescription">Manage sign-in, trusted devices, and one-way configuration transfers.</p>
        </div>
        <button class="cross-device-close" id="crossDeviceClose" type="button" aria-label="Close" data-icon="close"></button>
      </header>
      <div class="cross-device-status" id="crossDeviceStatus" role="status" aria-live="polite" hidden></div>
      <nav class="cross-device-tabs" id="crossDeviceTabs" role="tablist" aria-label="Device workspace sections">
        <button class="cross-device-tab is-active" type="button" role="tab" aria-selected="true" aria-controls="crossDeviceAccountView" data-cross-device-view="account">Account</button>
        <button class="cross-device-tab" type="button" role="tab" aria-selected="false" aria-controls="crossDeviceDevicesView" data-cross-device-view="devices">Devices</button>
      </nav>
      <div class="cross-device-content">
        <section class="cross-device-view" id="crossDeviceAccountView" role="tabpanel" data-cross-device-panel="account"><div id="crossDeviceAccountContent"></div></section>
        <section class="cross-device-view" id="crossDeviceDevicesView" role="tabpanel" data-cross-device-panel="devices" hidden><div id="crossDeviceDevicesContent"></div></section>
        <section class="cross-device-view" id="crossDeviceRegisterView" role="tabpanel" data-cross-device-panel="register" hidden><div id="crossDeviceRegisterContent"></div></section>
      </div>
    </section>
  </div>
</body></html>`;

const browser = await chromium.launch({ headless: true, ...(process.env.RAGENT_TEST_BROWSER_CHANNEL ? { channel: process.env.RAGENT_TEST_BROWSER_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => console.error(`cross-device pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error' || message.text().includes('Pairing QR rendering failed')) console.error(`cross-device console: ${message.text()}`); });
  await page.setContent(markup);
  await page.addStyleTag({ content: `body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; }\n${tokens}\n${components}\n${panelStyles}` });
  await page.evaluate(({ iconSource, qrCreatorSource, temporaryPairingFixture }) => {
    window.ragentT = (key) => key;
    window.ragentResolveProductPath = (path) => new URL(path, 'http://localhost/').toString();
    window.RagentFocusScope = { activate: () => () => {} };
    window.RagentBackHandler = { push: () => 'cross-device-test', pop: () => {} };
    window.open = (...args) => { window.__opened = args; };
    window.__requests = [];
    window.__googleStatus = { enabled: true, bound: false };
    window.__entryUrl = 'https://office.example.test/ragent';
    window.__entryUrlFailure = 0;
    window.__switchFailure = 0;
    window.__temporaryStatus = 'PENDING';
    window.__temporaryCompletionConfirmed = false;
    window.__temporaryErrorCode = '';
    window.fetch = async (url, options = {}) => {
      const path = new URL(url, 'http://localhost/').pathname;
      const body = options.body ? JSON.parse(options.body) : null;
      window.__requests.push({ path, body });
      const responses = {
        '/api/auth/google/status': window.__googleStatus,
        '/api/auth/google/binding-history': window.__googleStatus?.mode === 'accounts'
          ? { entries: [
            { instanceId: 'inst_local_001', action: 'bind', occurredAt: '2026-08-10T08:00:00.000Z' },
            { instanceId: 'inst_local_001', action: 'unbind', occurredAt: '2026-08-10T09:00:00.000Z' },
            { instanceId: 'inst_local_001', action: 'bind', occurredAt: '2026-08-10T10:00:00.000Z' },
          ] }
          : { entries: [{ deviceAlias: 'Office laptop', email: 'owner@example.test' }] },
        '/api/auth/google/devices': { devices: [
          { deviceId: 'inst_local_001', instanceId: 'inst_local_001', alias: 'Studio laptop', deviceKind: 'computer', instancePublicKey: 'local-key', sub: 'acct_owner_1', boundAt: '2026-08-10T08:00:00.000Z', unboundAt: null, lastSeenAt: '2026-08-10T10:00:00.000Z', source: 'local' },
          { deviceId: 'inst_remote_001', instanceId: 'inst_remote_001', alias: 'Office laptop', deviceKind: 'computer', instancePublicKey: 'remote-key', endpoint: 'https://office.example.test/ragent', sub: 'acct_owner_1', boundAt: '2026-08-10T07:00:00.000Z', unboundAt: null, lastSeenAt: '2026-08-10T09:30:00.000Z', source: 'remote' },
          { deviceId: 'inst_untrusted_001', instanceId: 'inst_untrusted_001', alias: 'Home laptop', deviceKind: 'computer', instancePublicKey: 'untrusted-key', endpoint: 'https://home.example.test/ragent', sub: 'acct_owner_1', boundAt: '2026-08-10T06:30:00.000Z', unboundAt: null, lastSeenAt: '2026-08-10T09:00:00.000Z', source: 'remote' },
          { deviceId: 'adev_phone_001', instanceId: 'adev_phone_001', alias: 'Pixel', deviceKind: 'phone', sub: 'acct_owner_1', boundAt: '2026-08-10T06:00:00.000Z', unboundAt: null, lastSeenAt: '2026-08-10T09:00:00.000Z', source: 'remote' },
          ...Array.from({ length: 6 }, (_, i) => ({ deviceId: `adev_more_${i}`, alias: 'Pixel', deviceKind: 'phone', boundAt: '2026-08-01T00:00:00.000Z', lastSeenAt: '2026-08-01T00:00:00.000Z' })),
          { deviceId: 'adev_unbound', alias: 'Old phone', deviceKind: 'phone', unboundAt: '2026-08-02T00:00:00.000Z' },
        ] },
        '/api/auth/google/unbind': { unbound: true, mode: 'accounts' },
        '/api/device-pairing/devices': { devices: [
          { id: 'rdev_remote_001', deviceName: 'Office laptop', platform: 'macOS', devicePublicKey: 'remote-key', entryUrl: window.__entryUrl, lastSeenAt: '2026-08-09T09:00:00Z' },
          { id: 'rdev_phone', deviceName: 'Phone', platform: 'Android', revokedAt: '2026-08-01T09:00:00Z' },
        ] },
        '/api/entry-switch/health': { reachable: true, statusCode: 200 },
        '/api/entry-switch/invite': { jumpUrl: 'https://office.example.test/ragent/?join=fixture' },
        '/api/device-pairing/invitations': { invitation: {
          id: 'rpinv_protocol_test_0001', accountHandoff: window.__accountHandoff === true,
          pairingUri: 'ragent://pair?v=3&i=inst_local_001&e=https%3A%2F%2Fcomputer.example.test&t=rpi_0123456789abcdef0123456789abcdef&x=2099-08-09T09%3A02%3A00.000Z', shortCode: 'AB12CD34', expiresAt: '2099-08-09T09:02:00Z',
        } },
        '/api/auth/google/bind': { authUrl: 'https://accounts.example.test/bind' },
      };
      let data = responses[path] ?? { error: `Unhandled test path: ${path}` };
      if (path.startsWith('/api/device-pairing/account-invitations/')) {
        if (path.endsWith('/approve')) window.__accountHandoffStatus = 'APPROVED';
        if (path.endsWith('/revoke')) window.__accountHandoffStatus = 'REVOKED';
        data = { invitation: { status: window.__accountHandoffStatus || 'CLAIMED', phoneFingerprint: 'b'.repeat(64) } };
      }
      if (path === '/api/device-pairing/temporary-control/invitations') {
        data = options.method === 'POST'
          ? { invitation: {
            envelope: temporaryPairingFixture.envelope,
            token: 'rtt_0123456789abcdefghijklmnopqrstuv',
          } }
          : { invitations: [{
            invitationId: 'rti_0123456789abcdefghijklmnopqrstuv',
            status: window.__temporaryStatus,
            claimedDevice: window.__temporaryStatus === 'CLAIMED' || window.__temporaryStatus === 'ACTIVE'
              ? { deviceKeyFingerprint: 'a'.repeat(64) } : null,
            accessExpiresAt: window.__temporaryStatus === 'ACTIVE' ? Date.now() + 600000 : null,
          }] };
      }
      const temporaryRevoke = /^\/api\/device-pairing\/temporary-control\/invitations\/(rti_[A-Za-z0-9_-]+)\/revoke$/.exec(path);
      if (temporaryRevoke && options.method === 'POST') {
        window.__temporaryStatus = 'REVOKED';
        data = { invitation: { status: 'REVOKED' }, businessAccessReady: false };
      }
      if (/^\/api\/device-pairing\/temporary-control\/invitations\/(rti_[A-Za-z0-9_-]+)\/confirm$/.test(path) && options.method === 'POST') {
        window.__temporaryStatus = 'ACTIVE';
        data = { invitation: { status: 'ACTIVE', accessExpiresAt: Date.now() + 600000 } };
      }
      if (path === '/api/entry-switch/invite' && options.method === 'POST' && window.__switchFailure) {
        data = { error: 'An entry-switch invitation for this device is already pending.' };
      }
      if (path === '/api/device-pairing/devices/rdev_remote_001/entry-url' && options.method === 'POST') {
        if (window.__entryUrlFailure) {
          data = { error: 'Owner access required' };
        } else {
          window.__entryUrl = body?.entryUrl || '';
          data = { device: { id: 'rdev_remote_001', entryUrl: window.__entryUrl } };
        }
      }
      if (path === '/api/auth/google/unbind' && options.method === 'POST') {
        window.__googleStatus = { enabled: true, bound: false, mode: 'accounts' };
      }
      if (path === '/api/device-pairing/temporary-control/invitations' && options.method === 'POST' && window.__temporaryErrorCode) {
        return new Response(JSON.stringify({ code: window.__temporaryErrorCode }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(data), {
        status: data.error
          ? (path === '/api/entry-switch/invite'
            ? (window.__switchFailure || 404)
            : (window.__entryUrlFailure || 404))
          : 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    (0, eval)(iconSource);
    (0, eval)(qrCreatorSource);
  }, { iconSource: icons, qrCreatorSource: qrCreator, temporaryPairingFixture });
  await page.addScriptTag({ content: panelSource });

  const opened = await page.evaluate(() => window.RagentCrossDevicePanel.open({ view: 'account' }));
  assert.equal(opened, true, 'workspace should open');
  await page.waitForSelector('#crossDeviceAccountContent .cross-device-card');
  assert.equal(await page.locator('#crossDeviceAccountContent .cross-device-card').count(), 1, 'account view should not show a history card');
  assert.equal(await page.locator('#crossDeviceOverlay').getAttribute('hidden'), null, 'overlay should be visible');
  assert.equal(await page.locator('#crossDeviceOverlay').getAttribute('inert'), null, 'visible overlay must remain interactive');
  assert.equal(await page.locator('#crossDeviceClose').isEnabled(), true, 'close button must remain interactive');
  await page.locator('#crossDeviceAccountContent input').fill('Studio laptop');
  await page.getByRole('button', { name: 'Bind Google sign-in' }).click();
  await page.waitForFunction(() => window.__opened?.[0]?.includes('/api/auth/google/bind/redirect'));
  const bindUrl = await page.evaluate(() => new URL(window.__opened[0]));
  assert.equal(bindUrl.pathname, '/api/auth/google/bind/redirect');
  assert.equal(bindUrl.searchParams.get('alias'), 'Studio laptop', 'binding should preserve the chosen device alias');
  assert.equal(await page.evaluate(() => window.__requests.some((request) => request.path === '/api/auth/google/bind')), false, 'binding navigation must not depend on a fetch response cookie');

  // ---------- accounts 模式：账号设备清单 + 服务端历史 + 解绑确认 ----------
  await page.evaluate(() => {
    window.__googleStatus = { enabled: true, bound: true, mode: 'accounts' };
  });
  await page.getByRole('button', { name: 'Refresh' }).first().click();
  await page.getByRole('heading', { name: 'Devices on this account' }).waitFor();
  assert.equal(await page.locator('#crossDeviceAccountContent .cross-device-device-row').count(), 10, 'only currently bound account records are shown');
  assert.equal(await page.getByRole('heading', { name: 'Computer records · 3' }).count(), 1);
  assert.equal(await page.getByRole('heading', { name: 'Mobile app installation records · 7' }).count(), 1);
  const accountList = page.locator('#crossDeviceAccountContent');
  assert.equal(await accountList.locator('.cross-device-account-more').first().getAttribute('open'), null, 'older phone records start collapsed');
  assert.equal(await accountList.getByText('Old phone').count(), 0, 'unbound records are not displayed');
  await accountList.getByText('Show 2 more records').click();
  assert.equal(await accountList.locator('.cross-device-account-group').nth(1).locator('.cross-device-device-row:visible').count(), 7, 'expanding retains same-named identities separately');
  const deviceRowTexts = await page.locator('#crossDeviceAccountContent .cross-device-device-row').allInnerTexts();
  assert.ok(deviceRowTexts[0]?.includes('Local'), 'local instance should be labeled');
  assert.ok(deviceRowTexts[1]?.includes('Remote'), 'remote instance should be labeled');
  assert.equal(await page.locator('#crossDeviceAccountContent .cross-device-history-row').count(), 0, 'binding history is not shown');
  assert.equal(await page.evaluate(() => window.__requests.some((request) => request.path === '/api/auth/google/binding-history')), false, 'account view should not request binding history');

  await page.getByRole('button', { name: 'Unbind this device' }).click();
  await page.getByRole('button', { name: 'Confirm unbind' }).click();
  await page.waitForFunction(() => window.__requests.some((request) => request.path === '/api/auth/google/unbind' && request.body === null));
  await page.getByText('Google account not bound').waitFor();
  assert.equal(await page.getByText('This device is no longer bound.').count(), 1, 'unbind should confirm with a status message');
  await page.screenshot({ path: `${reviewDir}/account-accounts-mode-390-light.png`, fullPage: true });

  // The Devices tab discovers account computers centrally, then consults the
  // local ledger only for the Web entry-switch capability.
  await page.evaluate(() => {
    window.__googleStatus = { enabled: true, bound: true, mode: 'accounts' };
    window.__requests = [];
  });
  await page.getByRole('tab', { name: 'Devices' }).click();
  await page.waitForSelector('#crossDeviceDevicesContent .cross-device-device-row');
  assert.equal(await page.locator('#crossDeviceDevicesContent .cross-device-device-row').count(), 3, 'device list should render account computers and omit phones');
  const devicesTabRows = await page.locator('#crossDeviceDevicesContent .cross-device-device-row').allInnerTexts();
  assert.ok(devicesTabRows.some((text) => text.includes('Studio laptop')), 'Devices tab should render the Accounts directory row');
  assert.ok(devicesTabRows.some((text) => text.includes('Office laptop')), 'Devices tab should render the remote Accounts computer');
  assert.equal(await page.getByRole('button', { name: 'Switch' }).count(), 1, 'only a locally trusted remote computer should be switchable');
  assert.equal(await page.getByText('Switch unavailable until this instance trusts the target.').count(), 1, 'untrusted account computer should explain why switching is unavailable');
  assert.equal(await page.evaluate(() => window.__requests.some((request) => request.path === '/api/auth/google/devices')), true, 'Devices tab should query the Accounts directory when signed in');
  assert.equal(await page.evaluate(() => window.__requests.some((request) => request.path === '/api/device-pairing/devices')), true, 'Devices tab should query the local ledger for switch capability');
  assert.equal(await page.getByText('https://office.example.test/ragent').count(), 1, 'the account endpoint should preserve its path');

  await page.evaluate(() => { window.__switchFailure = 409; });
  await page.getByRole('button', { name: 'Switch' }).click();
  await page.getByText('A switch link for this device is already pending. Try again shortly.').waitFor();
  await page.evaluate(() => { window.__switchFailure = 0; });

  // Entry URLs are stored in the local trusted ledger. The Accounts endpoint
  // remains a reference until the owner explicitly saves it here.
  await page.getByRole('button', { name: 'Edit entry URL' }).click();
  await page.screenshot({ path: `${reviewDir}/entry-editor-390-light.png`, fullPage: true });
  const entryInput = page.locator('#crossDeviceEntryUrl-rdev_remote_001');
  await entryInput.fill('ftp://office.example.test/ragent');
  await page.getByRole('button', { name: 'Save' }).click();
  assert.equal(await page.getByText('Enter a valid http(s) entry URL.').count(), 1, 'invalid entry URL should be rejected before the request');
  assert.equal(await page.evaluate(() => window.__requests.some((request) => request.path.endsWith('/entry-url'))), false, 'invalid entry URL must not be sent');

  await entryInput.fill('https://new-office.example.test/ragent?ignored=query#fragment');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Device entry URL saved.').waitFor();
  const saveRequest = await page.evaluate(() => window.__requests.find((request) => request.path.endsWith('/entry-url')));
  assert.deepEqual(saveRequest.body, { entryUrl: 'https://new-office.example.test/ragent' }, 'save should normalize query and fragment before sending');

  await page.getByRole('button', { name: 'Edit entry URL' }).click();
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.getByText('Device entry URL cleared.').waitFor();
  const clearRequest = await page.evaluate(() => window.__requests.filter((request) => request.path.endsWith('/entry-url')).at(-1));
  assert.deepEqual(clearRequest.body, { entryUrl: '' }, 'clear should send an empty entry URL');
  assert.equal(await page.getByRole('button', { name: 'Switch' }).count(), 0, 'clearing the local URL should disable entry switching');

  await page.getByRole('button', { name: 'Set entry URL' }).click();
  await page.locator('#crossDeviceEntryUrl-rdev_remote_001').fill('https://office.example.test/ragent');
  await page.evaluate(() => { window.__entryUrlFailure = 403; });
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Only the owner can update device entry URLs.').waitFor();
  await page.evaluate(() => { window.__entryUrlFailure = 0; });

  await page.getByRole('button', { name: 'Pair a device' }).click();
  await page.getByRole('button', { name: 'Create pairing code' }).click();
  await page.waitForFunction(() => window.__requests.some((request) => request.path === '/api/device-pairing/invitations'));
  await page.waitForSelector('.cross-device-pair-qr canvas');
  assert.equal(await page.locator('#crossDeviceInstanceId, #crossDevicePublicKey').count(), 0, 'pairing must not expose a manual device ID or public-key field');
  assert.equal(await page.locator('.cross-device-pair-qr canvas').count(), 1, 'pairing invitation should render a scannable QR code');
  assert.equal(await page.locator('.cross-device-pair-qr canvas').evaluate((canvas) => canvas.width), 512, 'pairing QR should preserve camera-readable module size');
  assert.equal(await decodeQrCanvas(page.locator('.cross-device-pair-qr canvas')),
    'ragent://pair?v=3&i=inst_local_001&e=https%3A%2F%2Fcomputer.example.test&t=rpi_0123456789abcdef0123456789abcdef&x=2099-08-09T09%3A02%3A00.000Z',
  'formal pairing QR must decode to the exact server-issued URI');
  assert.equal(await page.getByText('AB12CD34').count(), 1, 'pairing short code should be visible as a fallback');
  const pairingRequest = await page.evaluate(() => window.__requests.find((request) => request.path === '/api/device-pairing/invitations'));
  assert.deepEqual(pairingRequest.body, {}, 'pairing invitation should not transmit a client-supplied public key');
  await page.screenshot({ path: `${reviewDir}/pairing-390-light.png`, fullPage: true });
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.screenshot({ path: `${reviewDir}/pairing-390-dark.png`, fullPage: true });
  await page.evaluate(() => delete document.documentElement.dataset.theme);

  // Formal Google-backed trust and temporary no-Google access are distinct,
  // explicit modes. Temporary QR status is refreshed until completion and can
  // be revoked from the same screen.
  await page.getByRole('button', { name: 'Temporary · no sign-in' }).click();
  await page.getByRole('heading', { name: 'Temporary control · no Google sign-in' }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Temporary · no sign-in' }).evaluate((element) => element.getBoundingClientRect().height >= 44), 'pairing mode buttons should meet the 44px touch target');
  assert.equal(await page.getByText('After you confirm the phone, it can control this computer for 10 minutes, including projects, sessions, harnesses and providers.').count(), 1);
  await page.evaluate(() => { window.__temporaryErrorCode = 'temporary_control_broker_instance_unbound'; });
  await page.getByRole('button', { name: 'Create temporary code' }).click();
  await page.getByText('The server does not yet support pairing without Google sign-in. Update the temporary-control service and retry.').waitFor();
  assert.equal(await page.locator('.cross-device-pair-qr-temporary canvas').count(), 0, 'an unbound computer cannot display an invitation');
  await page.evaluate(() => { window.__temporaryErrorCode = ''; });
  await page.getByRole('button', { name: 'Create temporary code' }).click();
  await page.waitForFunction(() => document.querySelector('.cross-device-pair-qr-temporary canvas, .cross-device-pair-qr-temporary .cross-device-pair-qr-fallback'));
  assert.equal(await page.locator('.cross-device-pair-qr-temporary canvas').count(), 1,
    `temporary QR renderer should produce a standard QR canvas; fallback: ${await page.locator('.cross-device-pair-qr-temporary').innerText()}`);
  assert.equal(await page.locator('.cross-device-pair-qr-temporary canvas').evaluate((canvas) => canvas.width), 512, 'temporary QR should retain a camera-readable module size for the full signed envelope');
  const temporaryQrBounds = await page.locator('.cross-device-pair-qr-temporary canvas').evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    const container = canvas.parentElement.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      viewportWidth: window.innerWidth,
      containerLeft: container.left,
      containerRight: container.right,
    };
  });
  assert.ok(temporaryQrBounds.left >= temporaryQrBounds.containerLeft - 1
    && temporaryQrBounds.right <= temporaryQrBounds.containerRight + 1,
  `temporary pairing QR must fit its mobile card without clipping: ${JSON.stringify(temporaryQrBounds)}`);
  assert.ok(temporaryQrBounds.width <= 384 && temporaryQrBounds.width >= temporaryQrBounds.viewportWidth * 0.8,
    `temporary pairing QR should stay compact while remaining camera-readable: ${JSON.stringify(temporaryQrBounds)}`);
  const expectedTemporaryQr = JSON.stringify({
    kind: 'ragent-temporary-control-v1',
    version: 1,
    envelope: temporaryPairingFixture.envelope,
    token: 'rtt_0123456789abcdefghijklmnopqrstuv',
  });
  if (process.env.RAGENT_QR_OUTPUT_PATH) {
    const pngBase64 = await page.locator('.cross-device-pair-qr-temporary canvas')
      .evaluate((canvas) => canvas.toDataURL('image/png').split(',')[1]);
    await writeFile(process.env.RAGENT_QR_OUTPUT_PATH, Buffer.from(pngBase64, 'base64'));
  }
  assert.equal(await decodeQrCanvas(page.locator('.cross-device-pair-qr-temporary canvas')), expectedTemporaryQr,
    'temporary pairing QR must decode to the exact server-issued envelope and token');
  await page.setViewportSize({ width: 320, height: 844 });
  const compactQrBounds = await page.locator('.cross-device-pair-qr-temporary canvas').evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      parent: canvas.parentElement.getBoundingClientRect().toJSON(),
      pairing: canvas.closest('.cross-device-pairing').getBoundingClientRect().toJSON(),
      sheet: canvas.closest('.cross-device-sheet').getBoundingClientRect().toJSON(),
      overlay: canvas.closest('.cross-device-overlay').getBoundingClientRect().toJSON(),
    };
  });
  assert.ok(compactQrBounds.left >= -1 && compactQrBounds.right <= compactQrBounds.viewportWidth + 1,
    `temporary QR should remain visible at 320px without horizontal scrolling: ${JSON.stringify(compactQrBounds)}`);
  assert.ok(compactQrBounds.width <= 384 && compactQrBounds.width >= compactQrBounds.viewportWidth * 0.8,
    `320px pairing QR should stay compact while remaining camera-readable: ${JSON.stringify(compactQrBounds)}`);
  assert.ok(compactQrBounds.scrollWidth <= compactQrBounds.viewportWidth,
    `320px pairing view should not create horizontal page overflow: ${JSON.stringify(compactQrBounds)}`);
  await page.setViewportSize({ width: 824, height: 708 });
  const shortQrBounds = await page.locator('.cross-device-pair-qr-temporary canvas').evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: rect.height, viewportHeight: window.innerHeight };
  });
  assert.ok(shortQrBounds.bottom <= shortQrBounds.viewportHeight,
    `temporary QR should remain fully visible in a short desktop viewport: ${JSON.stringify(shortQrBounds)}`);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.getByText('Waiting for the phone to scan').count(), 1);
  assert.equal(await page.locator('.cross-device-pair-qr canvas').count(), 1, 'only the selected pairing mode should show a QR payload');
  await page.screenshot({ path: `${reviewDir}/pairing-temporary-390-light.png`, fullPage: true });
  const temporaryCreate = await page.evaluate(() => window.__requests.find((request) => request.path === '/api/device-pairing/temporary-control/invitations' && request.body !== null));
  assert.deepEqual(temporaryCreate.body, {}, 'temporary invitation must not accept client-selected identity or scope');
  await page.evaluate(() => {
    window.__temporaryStatus = 'CLAIMED';
  });
  await page.getByText('Phone scanned · confirm on this computer').waitFor({ timeout: 7000 });
  await page.getByText(`Phone key fingerprint: ${'a'.repeat(64)}`).waitFor();
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await page.getByRole('button', { name: 'Confirm 10-minute control' }).click();
  await page.getByText('Temporary control confirmed').waitFor();
  await page.getByRole('button', { name: 'Revoke code' }).click();
  await page.getByText('This temporary code was revoked').waitFor();
  assert.equal(await page.evaluate(() => window.__requests.some((request) => request.path.endsWith('/rti_0123456789abcdefghijklmnopqrstuv/revoke'))), true, 'revoke should target the displayed invitation');
  assert.equal(await page.getByRole('button', { name: 'Trusted · Google sign-in' }).getAttribute('aria-pressed'), 'false');
  await page.getByRole('button', { name: 'Trusted · Google sign-in' }).click();
  await page.getByRole('heading', { name: 'Trusted pairing · Google sign-in' }).waitFor();

  await page.getByRole('button', { name: 'Create another code' }).click();
  await page.evaluate(() => { window.__accountHandoff = true; });
  await page.getByRole('button', { name: 'Create pairing code' }).click();
  await page.getByText('Phone verified. Completing account sign-in automatically…').waitFor({ timeout: 7000 });
  assert.equal(await page.getByRole('button', { name: 'Authorize this phone for my account' }).count(), 0);
  await page.getByText('Scanning this code automatically authorizes your phone for this account. Only share it with your own phone.').waitFor();
  await page.getByText(`Phone key fingerprint: ${'b'.repeat(64)}`).waitFor();
  await page.evaluate(() => { window.__accountHandoffStatus = 'APPROVED'; });
  await page.getByText('Account access confirmed. Waiting for the phone to finish connecting.').waitFor();
  await page.getByRole('button', { name: 'Create another code' }).click();
  await page.evaluate(() => { window.__accountHandoffStatus = 'CLAIMED'; });
  await page.getByRole('button', { name: 'Create pairing code' }).click();
  await page.getByRole('button', { name: 'Cancel account authorization' }).click();
  await page.getByText('This pairing code is no longer active. Create another code.').waitFor();

  assert.equal(await page.getByRole('tab', { name: 'Sync' }).count(), 0, 'device workspace must not expose configuration sync');
  assert.equal(await page.locator('#crossDeviceSyncView').count(), 0, 'device workspace must not render a sync panel');
  assert.equal(await page.evaluate(() => window.__requests.some((request) => request.path.startsWith('/api/sync/'))), false, 'device workspace must not call sync endpoints');

  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    touchHeights: [...document.querySelectorAll('.cross-device-close, .cross-device-tab, .cross-device-action')]
      .filter((element) => !element.hidden && element.getBoundingClientRect().width > 0)
      .map((element) => element.getBoundingClientRect().height),
  }));
  assert.ok(layout.scrollWidth <= layout.viewportWidth, `mobile workspace must not overflow horizontally (${layout.scrollWidth} > ${layout.viewportWidth})`);
  assert.ok(layout.touchHeights.every((height) => height >= 44), `workspace controls must keep 44px touch targets: ${layout.touchHeights.join(', ')}`);
  await page.screenshot({ path: `${reviewDir}/devices-390-light.png`, fullPage: true });

  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.screenshot({ path: `${reviewDir}/devices-390-dark.png`, fullPage: true });
  await page.evaluate(() => window.RagentCrossDevicePanel.close());
  await page.setViewportSize({ width: 1024, height: 820 });
  await page.evaluate(() => window.RagentCrossDevicePanel.open({ view: 'devices' }));
  await page.waitForSelector('#crossDeviceDevicesContent .cross-device-device-row');
  await page.screenshot({ path: `${reviewDir}/devices-1024-dark.png`, fullPage: true });
  console.log(`test-chat-cross-device-panel: ok (${reviewDir})`);
} finally {
  await browser.close();
}

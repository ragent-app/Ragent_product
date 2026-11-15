// Accounts broker 的“电脑出码 / 手机授权”页面视觉与可访问性契约（Playwright Test 版）。

import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createOwnerAuthBroker } from '../../accounts/owner-auth-broker.mjs';
import { handleOwnerAuthRoutes } from '../../accounts/owner-auth-routes.mjs';
import {
  loadOrCreateInstanceIdentity,
  publicInstanceIdentity,
  signInstanceProof,
} from '../../lib/instance-identity.mjs';

const home = mkdtempSync(join(tmpdir(), 'ragent-owner-auth-phone-pages-'));
process.env.RAGENT_CONFIG_DIR = join(home, 'config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
delete process.env.RAGENT_INSTANCE_ROOT;

const state = {};
let broker;
let identity;
let server;
let port;

test.beforeAll(async () => {
  identity = await loadOrCreateInstanceIdentity();
  broker = createOwnerAuthBroker({
    store: { mutate: async (mutator) => mutator(state) },
    allowInsecureReturnUrl: true,
    verifyGoogleCredential: async () => ({ providerSubject: 'google-subject-1' }),
    resolveAccount: async () => ({ accountId: 'acct_owner_1' }),
    signAssertion: async () => 'not-used-in-visual-test',
  });

  server = http.createServer(async (req, res) => {
    const handled = await handleOwnerAuthRoutes({
      req,
      res,
      pathname: req.url || '/',
      broker,
      publicBaseUrl: `http://127.0.0.1:${port}/accounts`,
      googleWebClientId: 'google-web-client-id.apps.googleusercontent.com',
      allowInsecurePublicBaseUrl: true,
    });
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
});

function proofFor(transactionId, returnUrl) {
  const issuedAt = new Date().toISOString();
  return {
    transactionId,
    purpose: 'login',
    returnUrl,
    instance: publicInstanceIdentity(identity),
    issuedAt,
    audience: 'ragent-owner-auth',
    signature: signInstanceProof(identity, {
      transactionId,
      purpose: 'login',
      returnUrl,
      issuedAt,
      audience: 'ragent-owner-auth',
    }).signature,
  };
}

async function begin(transactionId) {
  const returnUrl = `http://instance.example.test/api/auth/google/complete?tx=${transactionId}`;
  const response = await fetch(`http://127.0.0.1:${port}/accounts/v1/owner-auth/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(proofFor(transactionId, returnUrl)),
  });
  expect(response.status).toBe(201);
  return response.json();
}

const reviewDir = 'artifacts/owner-auth-pages';

for (const [name, viewport] of [
  ['desktop-1024', { width: 1024, height: 768 }],
  ['mobile-390', { width: 390, height: 844 }],
]) {
  for (const colorScheme of ['light', 'dark']) {
    test(`二维码登录页 ${name} ${colorScheme} 不溢出且可扫描`, async ({ browser }) => {
      await mkdir(reviewDir, { recursive: true });
      const transactionId = `tx_visual_${name}_${colorScheme}`;
      const started = await begin(transactionId);
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme });
      const page = await context.newPage();
      await page.goto(started.authUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#ownerAuthQr canvas');
      expect(await page.getByRole('link', { name: '手机就在此页？直接继续登录' }).count()).toBe(1);
      const layout = await page.evaluate(() => ({
        viewport: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        actionHeights: [...document.querySelectorAll('.qr-login-actions .btn')].map(
          (element) => element.getBoundingClientRect().height,
        ),
        qrWidth: document.querySelector('#ownerAuthQr canvas')?.getBoundingClientRect().width || 0,
      }));
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewport);
      expect(layout.actionHeights.every((height) => height >= 44)).toBe(true);
      expect(layout.qrWidth).toBeGreaterThanOrEqual(220);
      await page.screenshot({ path: `${reviewDir}/${name}-${colorScheme}.png`, fullPage: true });
      await context.close();
    });
  }
}

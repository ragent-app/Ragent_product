#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const [executable, reportPath, mode = 'close'] = process.argv.slice(2);
assert.ok(executable, 'Usage: node tests/windows-desktop-manager-live.mjs <Ragent.exe> <report.json> [close|keep-open]');
assert.ok(reportPath, 'A report path is required');
assert.ok(['close', 'keep-open', 'wait'].includes(mode), 'Mode must be close, keep-open, or wait');

const report = { passed: false, mode, checks: [], failures: [] };
const record = (name, details = {}) => report.checks.push({ name, passed: true, ...details });
const getPort = async () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close((error) => error ? reject(error) : resolve(port));
  });
});
const waitForEndpoint = async (url, child, timeoutMs = 90000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`Ragent.exe exited before opening its manager window (${child.exitCode})`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('Timed out waiting for the installed AgentoC manager window');
};
const waitForExit = async (child, timeoutMs = 20000) => {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Ragent.exe did not exit after the manager window was closed')), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
};

let appProcess;
let browser;
let page;
try {
  const port = await getPort();
  const profileArgs = process.env.AGENTOC_DESKTOP_TEST_USER_DATA ? [`--user-data-dir=${process.env.AGENTOC_DESKTOP_TEST_USER_DATA}`] : [];
  appProcess = spawn(executable, [`--remote-debugging-port=${port}`, '--remote-allow-origins=*', ...profileArgs], {
    windowsHide: false,
    detached: mode === 'keep-open',
    stdio: 'ignore',
  });
  appProcess.once('error', (error) => report.failures.push(`Could not launch Ragent.exe: ${error.message}`));
  const endpoint = `http://127.0.0.1:${port}`;
  await waitForEndpoint(`${endpoint}/json/version`, appProcess);
  browser = await chromium.connectOverCDP(endpoint);
  const contexts = browser.contexts();
  assert.ok(contexts.length > 0, 'Electron did not expose a browser context');

  if (mode === 'wait') {
    const waitDeadline = Date.now() + 30000;
    while (Date.now() < waitDeadline) {
      page = contexts.flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('file:') && candidate.url().endsWith('/wait.html'));
      if (page) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(page, 'The service-unavailable window did not show its wait screen');
    await page.waitForSelector('#retry', { timeout: 10000 });
    assert.match(await page.locator('#serviceState').innerText(), /Waiting for the local AgentoC service/i);
    await page.locator('#retry').click();
    assert.match(await page.locator('#serviceState').innerText(), /Waiting for the local AgentoC service/i);
    record('service-not-ready wait screen and manual retry');
    await writeFile(`${reportPath}.waiting`, `${JSON.stringify({ readyForServiceRestart: true, checks: report.checks }, null, 2)}\n`, 'utf8');
  }

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (!page || !page.url().startsWith('http://127.0.0.1:7690/')) {
      page = contexts.flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('http://127.0.0.1:7690/'));
    }
    if (page) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.ok(page, 'The desktop window never connected to the local AgentoC service');
  await page.waitForSelector('#desktopManagerNav:not([hidden])', { timeout: 30000 });
  const managerUrl = new URL(page.url());
  assert.equal(managerUrl.origin, 'http://127.0.0.1:7690');
  assert.equal(managerUrl.pathname, '/');
  assert.equal(managerUrl.searchParams.get('desktop'), 'manager');
  assert.equal(await page.locator('body').evaluate((node) => node.classList.contains('desktop-manager')), true);
  assert.equal(await page.locator('.chat-area').evaluate((node) => getComputedStyle(node).display), 'none');
  assert.equal(await page.locator('.header').evaluate((node) => getComputedStyle(node).display), 'none');
  assert.equal(await page.locator('#desktopManagerNav [data-desktop-manager-tab]').count(), 5);
  await page.locator('[data-desktop-manager-tab="about"]').click();
  await page.waitForFunction(() => document.querySelector('#desktopManagerCurrentVersion')?.textContent.trim() !== '—', null, { timeout: 30000 });
  assert.equal((await page.locator('#desktopManagerCurrentVersion').innerText()).trim(), (await readFile(resolve(dirname(executable), '..', '.agentoc-package-version'), 'utf8')).trim());
  assert.equal(await page.locator('#desktopManagerAboutPanel').isVisible(), true);
  record('public version and About page');
  const healthz = await fetch('http://127.0.0.1:7690/healthz');
  const health = await healthz.json().catch(() => null);
  record('installed manager route and chat-free layout', {
    healthzStatus: healthz.status,
    controlPlaneHealth: health?.status || null,
    cliTransport: health?.cliTransport || null,
  });

  await page.locator('[data-desktop-manager-tab="harnesses"]').click();
  await page.waitForFunction(() => document.querySelector('#desktopManagerNav [data-desktop-manager-tab="harnesses"]')?.getAttribute('aria-current') === 'page');
  assert.equal(await page.locator('#harnessesPanel').evaluate((node) => node.classList.contains('visible') && !node.hidden), true);
  record('Harness navigation');

  // Exercise the real manager UI against an isolated fixture catalog so this
  // MSI smoke never installs or removes a third-party runtime on the runner.
  let fixtureHarnessInstalled = false;
  let fixtureHarnessVersion = '1.0.0';
  let failNextHarnessUpgrade = true;
  const harnessOperations = [];
  const fixtureHarness = () => ({
    id: 'desktop-manager-acceptance-fixture',
    name: 'Desktop manager acceptance fixture',
    supportedOnPlatform: true,
    installed: fixtureHarnessInstalled,
    available: fixtureHarnessInstalled,
    commandAvailable: fixtureHarnessInstalled,
    installationSource: 'managed',
    detectedVersion: fixtureHarnessInstalled ? fixtureHarnessVersion : '',
    targetVersion: '1.1.0',
    harnessVersion: '1.1.0',
    version: '1.1.0',
    upgradeAction: 'supported',
    compatibilityStatus: 'compatible',
  });
  await page.route('**/api/harnesses**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const operation = url.pathname.match(/\/api\/harnesses\/[^/]+\/(install|upgrade|uninstall)$/)?.[1];
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ harnesses: [fixtureHarness()] }),
      });
      return;
    }
    if (request.method() !== 'POST' || !operation) {
      await route.continue();
      return;
    }
    harnessOperations.push(operation);
    if (operation === 'upgrade' && failNextHarnessUpgrade) {
      failNextHarnessUpgrade = false;
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Harness is in use', code: 'HARNESS_IN_USE' }),
      });
      return;
    }
    fixtureHarnessInstalled = operation !== 'uninstall';
    if (operation === 'upgrade') fixtureHarnessVersion = '1.1.0';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ harness: fixtureHarness() }),
    });
  });
  await page.locator('#harnessesRefreshBtn').click();
  const fixtureCard = page.locator('#harnessesList [data-harness-id="desktop-manager-acceptance-fixture"]');
  await fixtureCard.waitFor({ state: 'visible', timeout: 15000 });
  const waitForHarnessActionCount = async (count) => {
    try {
      await page.waitForFunction((expected) => {
        const card = document.querySelector('#harnessesList [data-harness-id="desktop-manager-acceptance-fixture"]');
        return card?.querySelectorAll('.harness-card-actions button').length === expected;
      }, count, { timeout: 15000 });
    } catch (error) {
      const ui = await page.evaluate(() => {
        const card = document.querySelector('#harnessesList [data-harness-id="desktop-manager-acceptance-fixture"]');
        return {
          detail: card?.querySelector('.harness-card-detail')?.textContent || '',
          actions: Array.from(card?.querySelectorAll('.harness-card-actions button') || [], (button) => ({
            text: button.textContent,
            disabled: button.disabled,
          })),
          status: document.querySelector('#harnessesStatus')?.textContent || '',
        };
      }).catch(() => ({}));
      throw new Error(`${error.message}; harnessUi=${JSON.stringify(ui)}; routeOperations=${JSON.stringify(harnessOperations)}; fixtureInstalled=${fixtureHarnessInstalled}`);
    }
  };
  const confirmHarnessAction = () => page.evaluate(() => { window.confirm = () => true; });
  await confirmHarnessAction();
  await fixtureCard.locator('.harness-card-actions button.settings-row-button-primary').click();
  await waitForHarnessActionCount(2);
  assert.equal(fixtureHarnessInstalled, true);
  record('Harness install action and refreshed installed state');

  await confirmHarnessAction();
  await fixtureCard.locator('.harness-card-actions button').first().click();
  await page.waitForFunction(() => {
    const status = document.querySelector('#harnessesStatus');
    const message = status?.textContent?.trim() || '';
    return status && !status.hidden && /in use|正在使用中/i.test(message);
  }, null, { timeout: 15000 });
  await waitForHarnessActionCount(2);
  record('Harness operation failure feedback', { message: await page.locator('#harnessesStatus').innerText() });

  await confirmHarnessAction();
  await fixtureCard.locator('.harness-card-actions button').first().click();
  await page.waitForFunction(() => {
    const detail = document.querySelector('#harnessesList [data-harness-id="desktop-manager-acceptance-fixture"] .harness-card-detail')?.textContent || '';
    return /(?:Current v|当前 v)\s*1\.1\.0/.test(detail);
  }, null, { timeout: 15000 });
  assert.equal(fixtureHarnessVersion, '1.1.0');
  record('Harness upgrade action and refreshed version');

  await confirmHarnessAction();
  await fixtureCard.locator('.harness-card-actions button').last().click();
  await waitForHarnessActionCount(1);
  assert.equal(fixtureHarnessInstalled, false);
  assert.deepEqual(harnessOperations, ['install', 'upgrade', 'upgrade', 'uninstall']);
  record('Harness uninstall action and refreshed uninstalled state', { operations: harnessOperations });
  await page.unroute('**/api/harnesses**');

  if (mode === 'keep-open') {
    const piCard = page.locator('#harnessesList [data-harness-id="pi"]');
    const waitForCardActionCount = async (count) => page.waitForFunction((expected) => {
      const card = document.querySelector('#harnessesList [data-harness-id="pi"]');
      return card?.querySelectorAll('.harness-card-actions button').length === expected;
    }, count, { timeout: 300000 });
    const waitForPiOperation = (operation) => page.waitForResponse((response) => {
      const request = response.request();
      const url = new URL(response.url());
      return request.method() === 'POST' && url.pathname === `/api/harnesses/pi/${operation}`;
    }, { timeout: 300000 });
    const readPiOperation = async (response, operation) => {
      const body = await response.json().catch(() => ({}));
      assert.equal(response.status(), 200, `Pi ${operation} failed: ${JSON.stringify(body)}`);
      assert.ok(body.harness, `Pi ${operation} returned no Harness result`);
      return body.harness;
    };

    await page.locator('#harnessesRefreshBtn').click();
    await piCard.waitFor({ state: 'visible', timeout: 15000 });
    await waitForCardActionCount(1);
    await confirmHarnessAction();
    const piInstallResponse = waitForPiOperation('install');
    await piCard.locator('.harness-card-actions button.settings-row-button-primary').click();
    const installedPi = await readPiOperation(await piInstallResponse, 'install');
    assert.equal(installedPi.installed, true);
    assert.equal(installedPi.detectedVersion, '0.84.3');
    await waitForCardActionCount(2);
    record('Actual Pi Harness install through the MSI manager', { version: installedPi.detectedVersion });

    await confirmHarnessAction();
    const piUpgradeResponse = waitForPiOperation('upgrade');
    await piCard.locator('.harness-card-actions button').first().click();
    const upgradedPi = await readPiOperation(await piUpgradeResponse, 'upgrade');
    assert.equal(upgradedPi.installed, true);
    assert.equal(upgradedPi.upgraded, true);
    assert.equal(upgradedPi.detectedVersion, '0.84.3');
    await waitForCardActionCount(2);
    record('Actual Pi Harness upgrade through the MSI manager', { version: upgradedPi.detectedVersion });

    await confirmHarnessAction();
    const piUninstallResponse = waitForPiOperation('uninstall');
    await piCard.locator('.harness-card-actions button').last().click();
    const uninstalledPi = await readPiOperation(await piUninstallResponse, 'uninstall');
    assert.equal(uninstalledPi.uninstalled, true);
    assert.equal(uninstalledPi.installed, false);
    await waitForCardActionCount(1);
    record('Actual Pi Harness uninstall through the MSI manager', {
      filesRemoved: uninstalledPi.filesRemoved,
      cleanupPending: uninstalledPi.cleanupPending,
    });
  }

  await page.locator('[data-desktop-manager-tab="providers"]').click();
  await page.waitForFunction(() => document.querySelector('#desktopManagerNav [data-desktop-manager-tab="providers"]')?.getAttribute('aria-current') === 'page');
  assert.equal(await page.locator('#modelProvidersPanel').evaluate((node) => node.classList.contains('visible') && !node.hidden), true);
  record('Provider navigation');

  const pairingNav = page.locator('#desktopManagerNav [data-desktop-manager-tab="pairing"]');
  if (await pairingNav.isVisible()) {
    await pairingNav.click();
    assert.equal(await page.locator('#desktopManagerPairingPanel').isVisible(), true);
    assert.equal(await page.locator('#desktopManagerStartPairingBtn').isVisible(), true);
    record('phone pairing navigation');
  } else {
    record('phone pairing entry hidden for bound account');
  }

  await page.locator('[data-desktop-manager-tab="account"]').click();
  await page.locator('.desktop-manager-account-group').waitFor({ state: 'visible', timeout: 15000 });
  const accountViewVisible = await page.locator('.desktop-manager-account-group').isVisible();
  assert.equal(accountViewVisible, true, 'the account panel must remain visible after navigation');
  record('account management navigation');
  await page.screenshot({ path: reportPath.replace(/\.json$/i, '.png'), fullPage: true });

  const duplicate = spawn(executable, profileArgs, { windowsHide: true, stdio: 'ignore' });
  const duplicateExit = await waitForExit(duplicate, 15000);
  assert.equal(appProcess.exitCode, null, 'Launching a second instance closed the original manager process');
  record('duplicate launch exits while existing manager stays open', { duplicateExitCode: duplicateExit });

  if (mode === 'close' || mode === 'wait') {
    await page.close();
    const exitCode = await waitForExit(appProcess);
    assert.equal(exitCode, 0, 'The manager did not exit cleanly after its window closed');
    record('closing the manager window exits the desktop process');
  } else {
    // Disconnect the CDP WebSocket without sending Browser.close. Playwright
    // Browser.close() also waits for a remote Browser.Disconnected event that
    // Electron does not send after a client-side CDP transport close.
    browser._connection.close();
    browser = null;
    assert.equal(appProcess.exitCode, null, 'Disconnecting the CDP client closed the manager window');
    appProcess.unref();
    record('manager left open for the uninstall lifecycle check', { pid: appProcess.pid });
    appProcess = null;
  }
  if (browser) {
    await browser.close();
    browser = null;
  }
  report.passed = true;
} catch (error) {
  if (page) {
    try {
      report.uiFailure = await page.evaluate(() => {
        const selectors = ['#settingsPanel', '#desktopManagerGoogleAccountGroup', '#desktopManagerDevicesGroup', '#desktopManagerPageTitle', '#desktopManagerPairingPanel', '#desktopManagerNav', '#crossDeviceOverlay', '#crossDeviceSheet', '#crossDeviceDevicesView', '#crossDeviceDevicesContent', '#crossDeviceAccountView', '#crossDeviceAccountContent'];
        return Object.fromEntries(selectors.map((selector) => {
          const node = document.querySelector(selector);
          if (!node) return [selector, null];
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return [selector, {
            hidden: node.hidden,
            display: style.display,
            visibility: style.visibility,
            width: rect.width,
            height: rect.height,
            ariaCurrent: node.getAttribute('aria-current'),
          }];
        }));
      });
      await page.screenshot({ path: reportPath.replace(/\.json$/i, '.failure.png'), fullPage: true });
    } catch {}
  }
  report.failures.push(error.stack || String(error));
  if (browser) {
    try { browser._connection.close(); } catch {}
    browser = null;
  }
  if (appProcess && appProcess.exitCode === null) {
    appProcess.kill();
    await waitForExit(appProcess, 10000).catch(() => {});
  }
} finally {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

if (!report.passed) {
  process.stderr.write(`${report.failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  const summary = `windows-desktop-manager-live: ${report.checks.map(({ name }) => name).join('; ')}\n`;
  if (mode === 'keep-open') {
    await new Promise((resolve) => process.stdout.write(summary, resolve));
    // The detached Electron window is intentionally still running. Terminate
    // this short-lived smoke process after its report is durable so lingering
    // Playwright driver handles cannot stall the MSI lifecycle.
    process.exit(0);
  }
  process.stdout.write(summary);
}

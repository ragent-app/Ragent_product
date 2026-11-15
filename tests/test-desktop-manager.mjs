#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const root = new URL('../', import.meta.url);
const [managerScript, managerStyles, baseStyles, sidebarStyles, responsiveStyles, template, router, electronMain, preload, waitPage, installer, build, acceptance] = await Promise.all([
  readFile(new URL('static/chat/desktop-manager.js', root), 'utf8'),
  readFile(new URL('static/chat/desktop-manager.css', root), 'utf8'),
  readFile(new URL('static/chat/chat-base.css', root), 'utf8'),
  readFile(new URL('static/chat/chat-sidebar.css', root), 'utf8'),
  readFile(new URL('static/chat/chat-responsive.css', root), 'utf8'),
  readFile(new URL('templates/chat.html', root), 'utf8'),
  readFile(new URL('chat/router.mjs', root), 'utf8'),
  readFile(new URL('desktop/main.cjs', root), 'utf8'),
  readFile(new URL('desktop/preload.cjs', root), 'utf8'),
  readFile(new URL('desktop/wait.html', root), 'utf8'),
  readFile(new URL('packaging/windows/Ragent.wxs', root), 'utf8'),
  readFile(new URL('packaging/windows/build-msi.ps1', root), 'utf8'),
  readFile(new URL('tests/windows-desktop-manager-acceptance.ps1', root), 'utf8'),
]);

const androidLogo = await readFile(new URL('android/app/src/main/res/drawable-nodpi/adaptive_foreground_png.png', root));
const desktopLogo = await readFile(new URL('static/desktop/ragent-android-logo.png', root));
const crossDevicePanel = await readFile(new URL('static/chat/cross-device-panel.js', root), 'utf8');
assert.deepEqual(desktopLogo, androidLogo, 'Windows manager branding must reuse the Android logo asset exactly');

assert.match(router, /BODY_CLASS: parsedUrl\.query\?\.desktop === 'manager' \? 'desktop-manager' : ''/);
assert.match(template, /desktop\/ragent-android-logo\.png/);
assert.match(template, /id="desktopManagerNav"/);
assert.match(template, /id="desktopManagerGoogleAccountContent"/);
assert.match(template, /id="desktopManagerDevicesContent"/);
assert.match(template, /id="desktopManagerPageTitle"/);
assert.match(template, /id="desktopManagerStartPairingBtn"/);
assert.doesNotMatch(template, /id="desktopManagerAccountBtn"/);
assert.match(template, /class="settings-group desktop-manager-account-group"[^>]*hidden/);
assert.doesNotMatch(crossDevicePanel, /api\/auth\/google\/binding-history/, 'account UI should not render binding history');
assert.match(template, /id="desktopManager\.js|chat\/desktop-manager\.js/);
assert.match(electronMain, /requestSingleInstanceLock/);
assert.match(electronMain, /MANAGER_URL = `\$\{SERVICE_ORIGIN\}\/\?desktop=manager`/);
assert.match(electronMain, /http\.get\(MANAGER_URL,\s*\{[\s\S]*?Accept:\s*"\*\/\*"/);
assert.match(electronMain, /AUTH_HOSTS/);
assert.match(electronMain, /nodeIntegration: false/);
assert.match(electronMain, /contextIsolation: true/);
assert.match(electronMain, /sandbox: true/);
assert.doesNotMatch(electronMain, /shell\.openExternal\(\s*(?:url|targetUrl)\s*\)/);
assert.match(preload, /writeText: \(value\) => ipcRenderer\.invoke\("desktop:write-text", value\)/);
assert.doesNotMatch(preload, /exec|spawn|readFile|writeFile/);
assert.match(preload, /onExternalOpenFailed/);
assert.match(installer, /WixUnelevatedShellExec/);
assert.match(installer, /CloseApplication Id="CloseRagentManager" Target="Ragent\.exe" CloseMessage="yes" PromptToContinue="yes"/);
assert.match(installer, /EmbeddedUI Id="RagentMsiEmbeddedUI"/);
assert.match(installer, /Property Id="ARPPRODUCTICON" Value="RagentIcon"/);
assert.match(installer, /Property Id="RAGENT_LAUNCH"/);
assert.match(installer, /Target="\[INSTALLFOLDER\]payload\\Desktop\\Ragent\.exe"/);
assert.match(installer, /RagentStartMenuShortcut/);
assert.match(build, /generate-brand-assets\.ps1/);
assert.match(build, /stage-windows\.mjs/);
assert.match(build, /'\*\.d\.ts'/, 'staged runtime omits TypeScript-only declaration files to preserve the MSI size budget');
assert.match(build, /node_modules\\npm\\bin\\npm-cli\.js/);
assert.match(build, /node_modules\\corepack\\dist\\corepack\.js/);
assert.match(build, /wixtoolset\.org\/schemas\/v4\/wxs/);
assert.doesNotMatch(build, /Get-Command heat\.exe/);
assert.match(build, /600MB/);
assert.match(waitPage, /id="serviceState"/);
assert.match(waitPage, /img-src 'self'/);
assert.match(waitPage, /id="retry"/);
assert.match(waitPage, /ragentDesktop\?\.retryService/);
assert.match(acceptance, /existingOwnerCookieAccepted=\$true/);
assert.match(acceptance, /sqliteStorePresent=\$true/);
assert.doesNotMatch(acceptance, /OpenRead\([^\n]*auth-sessions\.sqlite/);
assert.match(acceptance, /healthzStatus -eq 200 -and \$healthzOk -and \$cliTransport -ceq 'ready'/, 'managed Owner service recovery must wait for the CLI transport health check');
assert.match(acceptance, /smokeTimeoutMs = if \(\$Mode -eq 'keep-open'\) \{ 600000 \} else \{ 210000 \}/, 'manager smoke must bound the detached Harness lifecycle and other smoke modes');
assert.match(acceptance, /WaitForExit\(\$smokeTimeoutMs\)/, 'manager smoke must use its bounded timeout before the MSI lifecycle can proceed');
assert.match(acceptance, /Get-Content -LiteralPath \$stdout \| Out-Host/, 'manager smoke output must not leak into the process ID returned for the open-window uninstall check');
assert.match(acceptance, /smokeExitCode = \[int\]\$process\.ExitCode/, 'manager smoke process exit code must be retained in Windows acceptance evidence');
assert.match(await readFile(new URL('tests/windows-desktop-manager-live.mjs', root), 'utf8'), /browser\._connection\.close\(\)/, 'the live MSI uninstall check must close only the CDP transport');
assert.match(await readFile(new URL('tests/windows-desktop-manager-live.mjs', root), 'utf8'), /mode === 'keep-open'[\s\S]*?process\.exit\(0\)/, 'the detached-window smoke must exit after its report is durable');
assert.match(await readFile(new URL('tests/windows-desktop-manager-live.mjs', root), 'utf8'), /accountViewVisible = await page\.locator\([^\n]+\)\.isVisible\(\)[\s\S]*?assert\.equal\(accountViewVisible, true/, 'account navigation must assert the live account panel stays visible');
assert.match(await readFile(new URL('tests/windows-desktop-manager-live.mjs', root), 'utf8'), /detached: mode === 'keep-open'/, 'the Electron window must survive its short-lived smoke launcher on Windows');

const managerMarkup = template
  .replaceAll('{{BODY_CLASS}}', 'desktop-manager')
  .replace(/<base\b[^>]*>/gi, '')
  .replace(/<link\b[^>]*>/gi, '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const normalMarkup = managerMarkup.replace('class="desktop-manager"', 'class=""');

const browser = await chromium.launch({ headless: true, ...(process.env.RAGENT_TEST_BROWSER_CHANNEL ? {channel: process.env.RAGENT_TEST_BROWSER_CHANNEL} : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  await page.setContent(managerMarkup);
  for (const content of [baseStyles, sidebarStyles, responsiveStyles, managerStyles]) {
    await page.addStyleTag({ content });
  }
  await page.evaluate(() => {
    window.__activeTab = 'settings';
    window.__updateOpens = 0;
    window.ragentDesktop = {
      getUpdateState: async () => ({ status: 'ready', currentVersion: '1.0.0', latestVersion: 'v1.1.0', updateAvailable: true }),
      checkForUpdates: async () => ({ status: 'ready', currentVersion: '1.0.0', latestVersion: 'v1.1.0', updateAvailable: true }),
      openUpdate: async () => { window.__updateOpens++; return true; },
      onUpdateState: (fn) => { window.__updateListener = fn; },
    };
    window.__openedViews = [];
  window.__managerRefreshes = 0;
    window.switchTab = (tab) => {
      window.__activeTab = tab;
      document.getElementById('sidebarSubpageHeader').hidden = tab === 'settings';
      for (const id of ['settingsPanel', 'modelProvidersPanel', 'harnessesPanel', 'accountPolicyPanel']) {
        const panel = document.getElementById(id);
        const active = id === ({ settings: 'settingsPanel', 'model-providers': 'modelProvidersPanel', harnesses: 'harnessesPanel', 'account-policy': 'accountPolicyPanel' })[tab];
        panel.hidden = !active;
        panel.classList.toggle('visible', active);
      }
    };
    window.getActiveSidebarTabValue = () => window.__activeTab;
    window.RagentCrossDevicePanel = {
      open: (options) => window.__openedViews.push(options.view),
      refreshManager: () => { window.__managerRefreshes += 1; },
    };
  });
  await page.addScriptTag({ content: managerScript });
  assert.equal(await page.locator('.header').evaluate((node) => getComputedStyle(node).display), 'none');
  assert.equal(await page.locator('.chat-area').evaluate((node) => getComputedStyle(node).display), 'none');
  assert.equal(await page.locator('#desktopManagerHeader').evaluate((node) => getComputedStyle(node).display), 'flex');
  assert.equal(await page.locator('#settingsPanel').evaluate((node) => getComputedStyle(node).display), 'block');
  assert.equal(await page.locator('.desktop-manager-account-group').evaluate((node) => getComputedStyle(node).display), 'block');
  assert.equal(await page.locator('#desktopManagerPageHeading').evaluate((node) => getComputedStyle(node).display), 'flex');
  assert.equal(await page.locator('#desktopManagerPageTitle').innerText(), 'Accounts & permissions');

  await page.locator('[data-desktop-manager-tab="about"]').click();
  await page.locator('[data-desktop-manager-tab="account"]').click();
  assert.equal(await page.locator('#settingsPanel').isVisible(), true, 'account settings return after About');
  await page.locator('[data-desktop-manager-tab="about"]').click();
  assert.equal(await page.locator('#desktopManagerCurrentVersion').innerText(), '1.0.0');
  assert.equal(await page.locator('#desktopManagerLatestVersion').innerText(), 'v1.1.0');
  await page.locator('#desktopManagerCheckUpdateBtn').click();
  await page.locator('#desktopManagerUpdateBtn').click();
  assert.equal(await page.evaluate(() => window.__updateOpens), 1);
  await page.evaluate(() => window.__updateListener({ status: 'ready', currentVersion: '1.1.0', latestVersion: 'v1.1.0', updateAvailable: false }));
  assert.equal(await page.locator('#desktopManagerUpdateBtn').isVisible(), false);
  await page.locator('[data-desktop-manager-tab="harnesses"]').click();
  assert.equal(await page.locator('#desktopManagerAboutPanel').isVisible(), false);
  assert.equal(await page.evaluate(() => window.__activeTab), 'harnesses');
  assert.equal(await page.locator('#desktopManagerPageTitle').innerText(), 'Harness management');
  await page.locator('[data-desktop-manager-tab="providers"]').click();
  assert.equal(await page.evaluate(() => window.__activeTab), 'model-providers');
  assert.equal(await page.locator('#desktopManagerPageTitle').innerText(), 'Model providers');
  await page.locator('[data-desktop-manager-tab="pairing"]').click();
  assert.equal(await page.locator('#desktopManagerPairingPanel').isVisible(), true);
  assert.equal(await page.locator('#desktopManagerPageTitle').innerText(), 'Phone pairing');
  assert.deepEqual(await page.evaluate(() => window.__openedViews), []);
  await page.locator('#desktopManagerStartPairingBtn').click();
  assert.deepEqual(await page.evaluate(() => window.__openedViews), ['register']);
  await page.locator('[data-desktop-manager-tab="account"]').click();
  assert.equal(await page.locator('#settingsPanel').evaluate((node) => getComputedStyle(node).display), 'block');
  assert.equal(await page.locator('#desktopManagerPairingPanel').isVisible(), false);
  assert.equal(await page.evaluate(() => window.__managerRefreshes), 3, 'account view should refresh Google and trusted-device data on entry');

  await page.evaluate(() => window.switchTab('account-policy'));
  assert.notEqual(await page.locator('#sidebarSubpageHeader').evaluate((node) => getComputedStyle(node).display), 'none');
  await page.locator('#sidebarSubpageCloseBtn').evaluate((node) => node.click());
  assert.equal(await page.evaluate(() => window.__activeTab), 'settings');

  const normalPage = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  await normalPage.setContent(normalMarkup);
  for (const content of [baseStyles, sidebarStyles, responsiveStyles, managerStyles]) {
    await normalPage.addStyleTag({ content });
  }
  await normalPage.locator('#settingsPanel').evaluate((node) => node.classList.add('visible'));
  assert.equal(await normalPage.locator('#desktopManagerHeader').evaluate((node) => getComputedStyle(node).display), 'none');
  assert.equal(await normalPage.locator('#desktopManagerNav').evaluate((node) => getComputedStyle(node).display), 'none');
  assert.equal(await normalPage.locator('#settingsPanel').evaluate((node) => getComputedStyle(node).display), 'block');
  assert.equal(await normalPage.locator('.desktop-manager-account-group').evaluate((node) => getComputedStyle(node).display), 'none');
  await normalPage.close();
} finally {
  await browser.close();
}

console.log('test-desktop-manager: management-only mode, four navigation paths, safe return and desktop shell contracts OK');

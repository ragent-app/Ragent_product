#!/usr/bin/env node
import assert from 'assert/strict';
import { createHmac } from 'crypto';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, delimiter } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';
import { DatabaseSync } from 'node:sqlite';
import { buildChildEnvironment } from '../scripts/launch-test-instance.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';
const visitorCookie = 'visitor_session_token=visitor-session';

function randomPort() {
  return 43000 + Math.floor(Math.random() * 10000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendOutput(buffer, chunk, limit = 8000) {
  const next = `${buffer}${chunk}`;
  return next.length <= limit ? next : next.slice(-limit);
}

function formatStartupOutput(stdout, stderr) {
  const sections = [];
  if (stderr.trim()) sections.push(`stderr:\n${stderr.trim()}`);
  if (stdout.trim()) sections.push(`stdout:\n${stdout.trim()}`);
  return sections.join('\n\n');
}

async function waitFor(predicate, description, timeoutMs = 10000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

function request(port, method, path, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Cookie: cookie,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...extraHeaders,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, text: data });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'ragent-chat-static-'));
  const configDir = join(home, '.ragent', 'config');
  const binDir = join(home, 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'auth-sessions.json'),
    JSON.stringify({
      'test-session': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
      'visitor-session': {
        expiry: Date.now() + 60 * 60 * 1000,
        role: 'visitor',
        agentId: 'shared-agent',
        sessionId: 'visitor-session-id',
        visitorId: 'visitor-123',
        preferredLanguage: 'zh-CN',
      },
    }, null, 2),
    'utf8',
  );

  return { home, binDir };
}

async function startServer({ home, binDir, port }) {
  const configDir = join(home, '.ragent', 'config');
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...buildChildEnvironment({id:'static-auth-'+process.pid,instanceDir:join(home,'.ragent'),configDir,
        memoryDir:join(home,'.ragent','memory'),workRootDir:join(home,'.ragent','workspace'),
        spoolDir:join(home,'.ragent','data','chat-runs'),providerHomesDir:join(home,'.ragent','provider-homes'),port},process.env),
      RAGENT_RUNNER_SUPERVISOR_SOCKET: "",
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: "",
      HOME: home,
      USERPROFILE: home,
      PATH: `${binDir}${delimiter}${process.env.PATH || ''}`,
      CHAT_PORT: String(port),
      RAGENT_INSTANCE_ROOT: join(home, '.ragent'),
      RAGENT_CONFIG_DIR: configDir,
      RAGENT_MEMORY_DIR: join(home, '.ragent', 'memory'),
      RAGENT_RUN_SPOOL_DIR: join(home, '.ragent', 'data', 'chat-runs'),
      RAGENT_PROVIDER_HOMES_DIR: join(home, '.ragent', 'provider-homes'),
      RAGENT_WORK_ROOT_DIR: join(home, '.ragent', 'workspace'),
      RAGENT_WINDOWS_SERVICE_MODE: '0',
      // Without a secret, lib/auth.mjs refuses to load auth-sessions.json and
      // the /api/auth/me owner assertion 401s.
      RAGENT_AUTH_SESSION_SECRET: "test-secret-ragent-static-assets",
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdout = appendOutput(stdout, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = appendOutput(stderr, chunk);
  });

  try {
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        const exitLabel = child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`;
        const output = formatStartupOutput(stdout, stderr);
        throw new Error(
          output
            ? `Server exited during startup with ${exitLabel}\n\n${output}`
            : `Server exited during startup with ${exitLabel}`,
        );
      }
      try {
        const res = await request(port, 'GET', '/login', null, { Cookie: '' });
        return res.status === 200;
      } catch {
        return false;
      }
    }, 'server startup');
  } catch (error) {
    const output = formatStartupOutput(stdout, stderr);
    if (!output || String(error.message).includes(output)) {
      throw error;
    }
    throw new Error(`${error.message}\n\n${output}`);
  }

  return { child };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const taskkill = spawn('taskkill', ['/pid', String(server.child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      taskkill.once('close', resolve);
      taskkill.once('error', resolve);
    });
  } else {
    server.child.kill('SIGTERM');
  }
  await waitFor(() => server.child.exitCode !== null, 'server shutdown');
}

async function main() {
  const { home, binDir } = setupTempHome();
  const sessionsFile = join(home, '.ragent', 'config', 'auth-sessions.json');
  const port = randomPort();
  let server;
  try {
    server = await startServer({ home, binDir, port });
    const authMe = await request(port, 'GET', '/api/auth/me');
    assert.equal(authMe.status, 200, 'auth info endpoint should work for owner session');
    assert.equal(authMe.headers['set-cookie']?.length, 1, 'auth info should refresh a near-expiry auth cookie');
    assert.match(authMe.headers['set-cookie'][0], /SameSite=Lax/i, 'auth cookie should use SameSite=Lax for better PWA compatibility');
    assert.match(authMe.headers['set-cookie'][0], /Max-Age=86400/i, 'auth cookie should include an explicit Max-Age');
    const authMeJson = JSON.parse(authMe.text);
    assert.equal(authMeJson.role, 'owner', 'auth info should identify the owner principal');
    assert.equal(authMeJson.surfaceMode, 'owner', 'owner auth should stay on the owner surface');
    assert.equal(authMeJson.principalKind, 'owner', 'owner auth should advertise the owner principal kind');
    assert.equal(authMeJson.capabilities?.manageAgents, true, 'owner auth should expose owner capabilities');
    // The legacy JSON is now a one-time input, never the current authority.
    const sessionDb = new DatabaseSync(join(dirname(sessionsFile), 'auth-sessions.sqlite'), { readOnly: true });
    const hashedKey = `s${createHmac('sha256', 'test-secret-ragent-static-assets').update('test-session').digest('hex')}`;
    const refreshed = sessionDb.prepare('SELECT expiry FROM sessions WHERE token_hash=?').get(hashedKey); sessionDb.close();
    assert.ok(
      refreshed?.expiry > Date.now() + 23 * 60 * 60 * 1000,
      'auth info should extend server-side session expiry as a sliding session',
    );

    const page = await request(port, 'GET', '/');
    assert.equal(page.status, 200, 'chat page should render for owner session');
    assert.match(page.text, /chat\/approval-explanation\.js\?v=/, 'approval explanation helper should be loaded with an asset version');
    const approvalExplanationAsset = await request(port, 'GET', '/chat/approval-explanation.js');
    assert.equal(approvalExplanationAsset.status, 200, 'approval explanation helper should be served');
    assert.match(approvalExplanationAsset.text, /ragentApprovalExplanation/);

    assert.match(page.text, /<meta name="color-scheme" content="light dark">/);
    assert.match(page.text, /<meta name="theme-color" content="#ffffff" media="\(prefers-color-scheme: light\)">/);
    assert.match(page.text, /<meta name="theme-color" content="#161618" media="\(prefers-color-scheme: dark\)">/);
    assert.doesNotMatch(page.text, /id="settingsConnectorsList"/, 'chat page should hide the connectors settings surface');
    assert.doesNotMatch(page.text, /id="workbenchInspector"/, 'chat page should not render the retired audit inspector');
    assert.match(page.text, /id="runSheet"/, 'chat page should expose Run Sheet as the single run-detail surface');
    assert.match(page.text, /id="runSheetBtn"/, 'chat header should expose the Run Sheet launcher');
    assert.match(page.text, /href="chat\/chat-home\.css(?:\?v=[^"]*)?"/, 'chat page should load the notification-driven home stylesheet');
    assert.match(page.text, /id="homeWorkspace"[^>]*aria-labelledby="homeWorkspaceTitle"/, 'chat page should mount the home workspace surface');
    assert.match(page.text, /id="rightSidebar"/, 'chat page should expose the workspace-scoped right sidebar');
    assert.match(page.text, /id="rightSidebarResizeHandle"/, 'workspace sidebar should expose a desktop resize handle');
    assert.match(page.text, /id="rightSidebarFilesBtn"/, 'workspace sidebar should expose a Files entry button');
    assert.match(page.text, /id="workspaceSummaryButton"/, 'workspace picker should expose a collapsed one-line summary button');
    assert.match(page.text, /id="workspaceSummaryText"/, 'workspace picker should expose a summary text target');
    assert.match(page.text, /id="workspacePopover"[^>]*role="dialog"[^>]*hidden/, 'workspace chooser should render as an initially hidden popover');
    assert.doesNotMatch(page.text, /id="workspaceConfirm"/, 'workspace chooser should retire the legacy confirm action after the project-list migration');
    assert.ok(
      page.text.indexOf('id="sidebarAppBar"') >= 0
        && page.text.indexOf('id="workspacePicker"') > page.text.indexOf('id="sidebarAppBar"')
        && page.text.indexOf('id="sessionList"') > page.text.indexOf('id="workspacePicker"'),
      'sidebar should render the app bar, workspace, and the session list in that order',
    );
    assert.doesNotMatch(page.text, /id="tabSettings"/, 'the sidebar nav Settings tab was removed');
    assert.match(page.text, /id="sidebarSearchModeHeader"[^>]*hidden/, 'unified search should start closed');
    assert.match(page.text, /id="sidebarFilterBtn"[^>]*data-icon="gear-solid"/, 'session list should expose the bottom-right Settings entry (solid gear icon)');
    assert.match(page.text, /class="[^"]*sidebar-new-chat-btn[^"]*"[^>]*id="newSessionBtn"/, 'new session should render as the bottom-left chat action');
    assert.match(page.text, /id="sidebarAccountBtn"[^>]*aria-controls="sidebarAccountPopover"/, 'sidebar should expose the frontend-only account status button');
    assert.match(page.text, /id="sidebarAgentBtn"[^>]*data-i18n-title="nav\.agents"/, 'sidebar should expose the Agent pill above the bottom-right controls');
    assert.match(
      page.text,
      /id="rightSidebarFilesView" hidden/,
      'workspace file view should stay hidden until the Files entry is opened',
    );
    assert.match(
      page.text,
      /id="workspaceFileReader"[^>]*hidden/,
      'workspace file reader should not render on the sidebar home view',
    );
    assert.match(
      page.text,
      /id="workspaceFileReaderBackBtn"[^>]*data-icon="chevron-left"[^>]*hidden/,
      'workspace file reader should expose a reading-mode back chevron',
    );
    assert.match(
      page.text,
      /id="workspaceFileReaderListResizeHandle"[^>]*role="separator"[^>]*aria-orientation="vertical"/,
      'workspace file reader should expose a resize handle for the file list column',
    );
    const bootstrapMatch = page.text.match(/window\.__RAGENT_BOOTSTRAP__ = ([^;]+);/);
    assert.ok(bootstrapMatch, 'chat page should inline bootstrap payload');
    const bootstrap = JSON.parse(bootstrapMatch[1]);
    assert.equal(bootstrap.auth?.role, 'owner', 'bootstrap payload should include owner auth');
    assert.equal(bootstrap.auth?.surfaceMode, 'owner', 'bootstrap auth should identify the owner surface');
    assert.equal(bootstrap.auth?.principalKind, 'owner', 'bootstrap auth should identify the owner principal kind');
    assert.equal(bootstrap.auth?.capabilities?.createSession, true, 'bootstrap auth should expose owner capabilities');
    assert.equal(bootstrap.defaultSessionFolder, join(home, '.ragent', 'workspace'), 'bootstrap should expose the managed default session folder');
    assert.equal(Object.prototype.hasOwnProperty.call(bootstrap, 'settings'), false, 'bootstrap should not expose removed voice settings');
    assert.match(page.text, /<script src="chat\/run-activity-ui\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/session-store\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/composer-store\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/motion\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/bootstrap\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/bootstrap-session-catalog\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/session-http-helpers\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/session-http-list-state\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/session-http\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/layout-tooling\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/tooling\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/realtime\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/realtime-render\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/ui\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/run-sheet\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/home-workspace\.js(?:\?v=[^"]*)?"/);
    assert.doesNotMatch(page.text, /<script src="chat\/workbench-inspector\.js/);
    assert.match(page.text, /<script src="chat\/workspace-file-reader\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/right-sidebar\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/session-surface-ui\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/session-list-ui\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/model-providers\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/harness-management\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /id="modelProvidersSettingsSection"[^>]*hidden/, 'model providers entry should start hidden until owner bootstrap is applied');
    assert.match(page.text, /id="harnessesOpenBtn"/, 'runtime settings should expose local Harness management');
    assert.match(page.text, /id="harnessesPanel"[^>]*hidden/, 'Harness management should start as a hidden subpage');
    assert.doesNotMatch(page.text, /chat\/(?:cc-switch-settings|provider-onboarding)\.js/);
    assert.doesNotMatch(page.text, /chat\/(?:instance-settings|voice-input)\.js/);

    const modelProvidersAsset = await request(port, 'GET', '/chat/model-providers.js');
    assert.equal(modelProvidersAsset.status, 200, 'model providers asset should load');
    assert.match(modelProvidersAsset.text, /settingsSection\.hidden = !canManage\(\)/, 'model providers should reveal its settings entry for owner sessions');
    assert.match(modelProvidersAsset.text, /if \(type !== "select"\) input\.type = type;/, 'provider fields should not assign the read-only HTMLSelectElement.type property');
    assert.match(modelProvidersAsset.text, /navigator\.clipboard\.writeText/, 'official login should copy the device code');
    assert.match(modelProvidersAsset.text, /model-provider-device-code/, 'official login should show the device code in the settings UI');
    assert.match(modelProvidersAsset.text, /modelProviders\.copyDeviceCode/, 'official login should keep a manual device-code copy action');
    assert.match(modelProvidersAsset.text, /globalScope\.open\?\.\(job\.url/, 'official login should open the device login page without losing the polling page');
    assert.match(modelProvidersAsset.text, /\[job\.failureCode\]/, 'official login should use the server failure classification');
    assert.match(modelProvidersAsset.text, /loginFailureOfficialAuth/, 'official login should explain an authorization-page rejection');
    assert.match(modelProvidersAsset.text, /oauthHandoffStarted = false;/, 'official login should allow a retry after a failed handoff');
    assert.match(modelProvidersAsset.text, /agentSelect\.value === "claude"\) modeSelect\.value = "oauth-token"/, 'Claude providers should default to setup-token');
    assert.match(modelProvidersAsset.text, /officialOAuthOption\.hidden = agentSelect\.value === "claude"/, 'Claude providers must not expose normal OAuth');
    assert.match(modelProvidersAsset.text, /modeSelect\.disabled = \(isEditing && !isLegacyClaudeOAuth\)/, 'legacy Claude OAuth must remain editable for setup-token migration');
    assert.match(modelProvidersAsset.text, /native-provider-oauth\/jobs.*\/input/, 'agy login should submit browser credentials to the active job');
    assert.match(modelProvidersAsset.text, /\/api\/harnesses/, 'model provider form should load harness protocol capabilities');
    assert.match(modelProvidersAsset.text, /model-provider-protocol-hint/, 'model provider form should place protocol guidance beside the API URL');
    assert.match(modelProvidersAsset.text, /modelProviders\.supportedProtocols/, 'model provider form should translate the selected harness protocol guidance');
    assert.match(modelProvidersAsset.text, /\["agy", "agy"\]/, 'model providers should offer agy official login');
    assert.match(
      modelProvidersAsset.text,
      /if \(isApiKeyOnlyHarnessType\(agentSelect\.value\)\) modeSelect\.value = "api-key";/,
      'only API-key-only Harnesses should force API-key mode',
    );
    assert.doesNotMatch(
      modelProvidersAsset.text,
      /if \(isHarnessType\(agentSelect\.value\)\) modeSelect\.value = "api-key";/,
      'native Codex runtime must keep OAuth mode selectable',
    );
    assert.match(modelProvidersAsset.text, /claudeMigrationTitle/, 'legacy Claude OAuth should expose a setup-token migration path');
    assert.match(modelProvidersAsset.text, /method: "PATCH"/, 'model providers should support editing existing configurations');
    assert.match(modelProvidersAsset.text, /replaceExisting: true/, 'official provider editing should support re-login');
    assert.match(modelProvidersAsset.text, /modelProviders\.relogin/, 'official provider editing should expose a re-login action');
    assert.match(modelProvidersAsset.text, /if \(provider\.agentType === "agy"\)[\s\S]*?rebindButton[\s\S]*?deleteButton[\s\S]*?deleteProvider\(provider\)/, 'agy provider cards should expose relink and delete actions');
    const harnessManagementAsset = await request(port, 'GET', '/chat/harness-management.js');
    assert.equal(harnessManagementAsset.status, 200, 'Harness management asset should load');
    assert.match(harnessManagementAsset.text, /\/api\/harnesses/);
    assert.match(harnessManagementAsset.text, /operation === "upgrade"/);
    assert.match(harnessManagementAsset.text, /compatibilityStatus === "incompatible"/);
    assert.match(harnessManagementAsset.text, /addAction\(\s*"upgrade"/, 'managed Harnesses should offer upgrade');
    assert.match(harnessManagementAsset.text, /upgradeAction === "package-managed"/);
    assert.match(harnessManagementAsset.text, /installationSource === "bundled"/);
    assert.match(harnessManagementAsset.text, /upgradeAction !== "manual" && !packageManaged/);
    assert.match(harnessManagementAsset.text, /ragentRefreshRuntimeCatalog/);

    const harnessCatalog = await request(port, 'GET', '/api/harnesses');
    assert.equal(harnessCatalog.status, 200, 'owner should be able to read harness protocol capabilities');
    const harnessCatalogJson = JSON.parse(harnessCatalog.text);
    assert.deepEqual(
      harnessCatalogJson.harnesses.find((harness) => harness.id === 'codex')?.providerProtocols,
      ['openai-responses', 'openai-chat'],
      'harness catalog should expose Codex API protocol capabilities to the provider form',
    );

    const homeWorkspaceAsset = await request(port, 'GET', '/chat/home-workspace.js');
    assert.equal(homeWorkspaceAsset.status, 200, 'home workspace asset should load');
    assert.match(homeWorkspaceAsset.text, /function fetchHomeData\(/);
    assert.match(homeWorkspaceAsset.text, /requestHomeWorkspaceRefresh/);
    assert.match(homeWorkspaceAsset.text, /\/?session=\$\{encodeURIComponent\(sessionId\)\}/, 'home actions should use the canonical session URL parameter');

    const homeWorkspaceStyles = await request(port, 'GET', '/chat/chat-home.css');
    assert.equal(homeWorkspaceStyles.status, 200, 'home workspace stylesheet should load');
    assert.match(homeWorkspaceStyles.text, /\.home-focus-layout/);
    assert.match(homeWorkspaceStyles.text, /@media \(max-width: 760px\)/);
    assert.match(page.text, /<script src="chat\/settings-ui\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/sidebar-ui\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/compose\.js(?:\?v=[^"]*)?"/);
    assert.doesNotMatch(page.text, /voiceInput|voice-input|Voice Input/, 'chat page should not expose voice input UI or assets');

    const homeProjection = await request(port, 'GET', '/api/home');
    assert.equal(homeProjection.status, 200, 'owner should be able to read the home projection');
    const homeProjectionJson = JSON.parse(homeProjection.text);
    assert.ok(Array.isArray(homeProjectionJson.focusItems), 'home projection should expose focus items');
    assert.ok(Array.isArray(homeProjectionJson.inProgress), 'home projection should expose running items');
    assert.ok(Array.isArray(homeProjectionJson.upcomingAutomation), 'home projection should expose scheduled items');
    assert.ok(Array.isArray(homeProjectionJson.recentResults), 'home projection should expose recent results');
    assert.equal(typeof homeProjectionJson.counts?.focus, 'number', 'home projection should expose focus count');
    const visitorHomeProjection = await request(port, 'GET', '/api/home', null, { Cookie: visitorCookie });
    assert.equal(visitorHomeProjection.status, 403, 'visitor should not be able to read the owner home projection');

    const visitorNativeProviders = await request(port, 'GET', '/api/native-providers', null, { Cookie: visitorCookie });
    assert.equal(visitorNativeProviders.status, 403, 'visitor should not be able to read native provider profiles');

    const ownerNativeProvidersBefore = await request(port, 'GET', '/api/native-providers');
    assert.equal(ownerNativeProvidersBefore.status, 200, 'owner should be able to read native provider profiles');
    assert.match(ownerNativeProvidersBefore.headers['cache-control'] || '', /no-store/);
    assert.deepEqual(JSON.parse(ownerNativeProvidersBefore.text).providers, []);

    const createdNativeProvider = await request(port, 'POST', '/api/native-providers', {
      agentType: 'codex',
      displayName: 'Fixture Native',
      baseUrl: 'https://api.example.test/v1',
      protocol: 'chat',
      apiKey: 'fixture-native-secret',
      discoverModels: false,
    });
    assert.equal(createdNativeProvider.status, 201, 'owner should be able to add a native provider');
    const createdNativeProviderJson = JSON.parse(createdNativeProvider.text);
    assert.equal(createdNativeProviderJson.provider.protocol, 'openai-chat');
    assert.doesNotMatch(createdNativeProvider.text, /fixture-native-secret/);
    const editedNativeProvider = await request(port, 'PATCH', `/api/native-providers/${encodeURIComponent(createdNativeProviderJson.provider.id)}`, {
      displayName: 'Fixture Native Edited',
      baseUrl: 'https://api.example.test/edited',
      protocol: 'responses',
      defaultModel: 'gpt-5.6',
      apiKey: '',
    });
    assert.equal(editedNativeProvider.status, 200, 'owner should be able to edit a native provider');
    assert.equal(JSON.parse(editedNativeProvider.text).provider.displayName, 'Fixture Native Edited');
    assert.equal(JSON.parse(editedNativeProvider.text).provider.protocol, 'openai-responses');
    const ownerNativeProvidersAfter = await request(port, 'GET', '/api/native-providers');
    assert.equal(JSON.parse(ownerNativeProvidersAfter.text).providers.length, 1);
    const deletedNativeProvider = await request(port, 'DELETE', `/api/native-providers/${encodeURIComponent(createdNativeProviderJson.provider.id)}`);
    assert.equal(deletedNativeProvider.status, 200, 'owner should be able to remove a native provider');

    const visitorPage = await request(port, 'GET', '/?visitor=1', null, { Cookie: visitorCookie });
    assert.equal(visitorPage.status, 200, 'chat page should also render for visitor session');
    const visitorBootstrapMatch = visitorPage.text.match(/window\.__RAGENT_BOOTSTRAP__ = ([^;]+);/);
    assert.ok(visitorBootstrapMatch, 'visitor page should inline bootstrap payload');
    const visitorBootstrap = JSON.parse(visitorBootstrapMatch[1]);
    assert.equal(visitorBootstrap.auth?.role, 'visitor', 'visitor page should inline visitor auth');
    assert.equal(visitorBootstrap.auth?.surfaceMode, 'visitor', 'legacy visitor bootstrap should stay on visitor surface mode');
    assert.equal(visitorBootstrap.auth?.principalKind, 'visitor', 'legacy visitor bootstrap should preserve the visitor principal kind');
    assert.equal(visitorBootstrap.auth?.agentId, 'shared-agent', 'legacy visitor bootstrap should keep the shared agent id');
    assert.equal(visitorBootstrap.auth?.preferredLanguage, 'zh-CN', 'legacy visitor bootstrap should retain preferred language');
    assert.equal(visitorBootstrap.auth?.sessionId, 'visitor-session-id', 'legacy visitor bootstrap should expose the pinned session id');
    assert.equal(visitorBootstrap.auth?.visitorId, 'visitor-123', 'legacy visitor bootstrap should expose visitor identity');
    assert.equal(visitorBootstrap.auth?.capabilities?.listSessions, false, 'legacy visitor bootstrap should not expose multi-session list access');
    assert.equal(Object.prototype.hasOwnProperty.call(visitorBootstrap, 'settings'), false, 'visitor bootstrap should not expose removed voice settings');
    assert.match(page.text, /<script src="chat\/init\.js(?:\?v=[^"]*)?"/);
    assert.doesNotMatch(page.text, /id="appFilterSelect"/);
    assert.doesNotMatch(page.text, /id="sourceFilterSelect"/, 'the source filter panel was removed');
    assert.doesNotMatch(page.text, /id="sessionAppFilterSelect"/);
    assert.doesNotMatch(page.text, /id="userFilterSelect"/);
    assert.doesNotMatch(page.text, /id="sortSessionListBtn"/, 'sort list button should not render in the session sidebar');
    assert.doesNotMatch(page.text, /id="sessionListFooter"/, 'build label footer should not render in the session sidebar');
    assert.doesNotMatch(page.text, /data-i18n-build-label/, 'build label translation hook should not render in the session sidebar');
    assert.match(page.text, /id="settingsSessionPresentationList"/);
    assert.doesNotMatch(page.text, /id="voiceInput/);
    assert.doesNotMatch(page.text, /id="voiceBtn"/);
    assert.doesNotMatch(page.text, /id="settingsUsersList"/);
    assert.doesNotMatch(page.text, /id="settingsAppsList"/);
    assert.doesNotMatch(page.text, /id="newUserNameInput"/);
    assert.doesNotMatch(page.text, /id="createUserBtn"/);
    assert.doesNotMatch(page.text, /id="newAppNameInput"/);
    assert.doesNotMatch(page.text, /id="newAppToolSelect"/);
    assert.doesNotMatch(page.text, /id="newAppWelcomeInput"/);
    assert.doesNotMatch(page.text, /id="newAppSystemPromptInput"/);
    assert.doesNotMatch(page.text, /id="createAppConfigBtn"/);
    assert.doesNotMatch(page.text, /id="voiceSettingsMount"/);
    assert.doesNotMatch(page.text, /id="voiceInputBtn"/);
    assert.doesNotMatch(page.text, /id="voiceFileInput"/);
    assert.doesNotMatch(page.text, /id="voiceCleanupToggle"/);
    assert.match(page.text, /class="header-btn header-btn--sessions" id="menuBtn"/, 'mobile header should promote the session entry as a primary button');
    assert.match(page.text, /class="header-leading-actions"[\s\S]*?id="menuBtn"[\s\S]*?id="homeBtn"/, 'mobile header should combine hamburger and Home in one leading capsule');
    assert.match(page.text, /id="menuBtn"[\s\S]*class="header-btn-icon" data-icon="menu"/, 'session button should render the menu icon');
    assert.doesNotMatch(page.text, /id="menuBtn"[\s\S]*class="header-btn-label"[\s\S]*<\/button>/, 'session button should not render a visible text label');
    assert.match(page.text, /class="header-btn header-btn--home" id="homeBtn"/, 'mobile header should expose a dedicated home button beside sessions');
    assert.match(page.text, /id="homeBtn"[\s\S]*class="header-btn-icon" data-icon="home"/, 'home button should use the shared home icon');
    assert.match(page.text, /id="homeBtn"[\s\S]*data-i18n-aria-label="nav\.home"/, 'home button should expose a localized accessible name');
    assert.match(page.text, /id="headerMoreBtn"[\s\S]*data-icon="more"/, 'More should use the Android-style vertical dots icon');
    // The sidebar is normalized at runtime rather than emitted as final HTML.
    // Runtime DOM behavior is also covered by test-chat-sidebar-runtime-normalizer.
    const sidebarBootstrap = await request(port, 'GET', '/chat/bootstrap.js');
    assert.equal(sidebarBootstrap.status, 200);
    assert.match(sidebarBootstrap.text, /sidebarElement\.prepend\(appBar,/, 'normalized sidebar places the app bar first');
    assert.match(sidebarBootstrap.text, /brand\.className = "sidebar-brand";\s*brand\.textContent = "Ragent"/);
    assert.match(sidebarBootstrap.text, /closeButton\.className = "sidebar-icon-btn";[\s\S]*?closeButton\.setAttribute\("data-icon", "chevron-left"\)/);
    assert.match(sidebarBootstrap.text, /legacyTabs\?\.remove\?\.\(\)/, 'normalization removes legacy tabs');
    assert.doesNotMatch(page.text, /id="forkSessionBtn"/, 'fork should no longer occupy the top header');
        assert.doesNotMatch(page.text, /id="shareSnapshotBtn"/, 'share snapshot button should be removed (product is app-first, not web)');
    // Header + sidebar project row styling must live in the loaded stylesheet
    // chain, not in the retired workbench sheet (chat-workbench.css is never
    // loaded — a past migration stranded these rules there, leaving the Run
    // Sheet button and the project create button completely unstyled).
    const baseCss = readFileSync(join(repoRoot, 'static/chat/chat-base.css'), 'utf8');
    const responsiveCss = readFileSync(join(repoRoot, 'static/chat/chat-responsive.css'), 'utf8');
    assert.match(baseCss, /\.header-btn--home\s*\{[\s\S]*?display:\s*none;/, 'home button should stay out of desktop layout until mobile rules opt it in');
    assert.match(responsiveCss, /\.header-btn--home\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?width:\s*40px;[\s\S]*?height:\s*40px;/, 'mobile home button should meet the 40px compact touch target');
    assert.match(
      baseCss,
      /\.header-review-btn,\s*\.header-sidebar-btn\s*\{[\s\S]*?width:\s*34px;/,
      'Run Sheet and Sidebar header buttons should keep the standard 34px round button styling in the loaded base sheet',
    );
    assert.match(
      responsiveCss,
      /\.header-share-btn,\s*\.header-review-btn,\s*\.header-sidebar-btn,\s*\.header-refresh-btn\s*\{[\s\S]*?display:\s*none\s*!important;/,
      'mobile header should fold the Run Sheet button into the overflow menu',
    );
    const sidebarCss = readFileSync(join(repoRoot, 'static/chat/chat-sidebar.css'), 'utf8');
    assert.match(
      sidebarCss,
      /\.sidebar-project-create-btn\s*\{[\s\S]*?border-radius:\s*999px;/,
      'project create button should render as a styled round icon button, not a bare default button',
    );
    assert.match(
      sidebarCss,
      /\.sidebar-primary-nav \.sidebar-workspace-summary\s*\{[\s\S]*?grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto;/,
      'workspace summary row should lay the folder icon, name and chevron out on one aligned line',
    );
    // The project-scoped UI (create dialog, folder picker, switcher list)
    // shipped with no stylesheet at all; lock the core surfaces into the
    // loaded chain so they can never render as bare DOM again.
    assert.match(
      sidebarCss,
      /\.project-create-dialog__sheet\s*\{[\s\S]*?border-radius:\s*24px;/,
      'project create dialog should render as a rounded glass sheet',
    );
    assert.match(
      sidebarCss,
      /\.folder-tree-picker\s*\{[\s\S]*?display:\s*grid;/,
      'folder picker should render with the styled layout, not bare stacked DOM',
    );
    assert.match(
      sidebarCss,
      /\.sidebar-project-option\s*\{[\s\S]*?grid-template-columns:\s*22px minmax\(0,\s*1fr\) auto;/,
      'project switcher rows should align icon, name and session count on one row',
    );
    assert.match(page.text, /class="input-config-row"[\s\S]*class="input-wrapper"/, 'composer should keep tooling controls above the dedicated input shell');
    assert.match(page.text, /id="msgInput"[\s\S]*class="input-actions-row"[\s\S]*id="imgBtn"[\s\S]*id="sendBtn"/, 'composer should stack textarea above the action row so buttons no longer squeeze the text width');
    assert.match(page.text, /id="quickEntryFocusPrompt" hidden/, 'chat page should include the quick-entry focus recovery prompt shell');
    assert.doesNotMatch(page.text, /id="workbenchInspectorBackBtn"/, 'retired audit navigation should not remain in the page');
    assert.doesNotMatch(page.text, /id="collapseBtn"/, 'desktop sidebar should no longer expose a collapse control');
    assert.doesNotMatch(page.text, /id="tabProgress"/);
    assert.doesNotMatch(page.text, /id="saveTemplateBtn"/);
    assert.doesNotMatch(page.text, /id="sessionTemplateSelect"/);
    assert.match(page.text, /<div class="app-shell">/, 'chat page should render inside a dedicated app shell');
    assert.match(page.text, /chat\/chat\.css\?v=/, 'chat page should fingerprint the split chat stylesheet');
    const chatStylesheet = await request(port, 'GET', '/chat/chat.css');
    assert.equal(chatStylesheet.status, 200, 'chat stylesheet should load');
    assert.equal(
      chatStylesheet.headers['cache-control'],
      'public, no-cache, max-age=0, must-revalidate',
      'chat stylesheet should use safe revalidation caching',
    );
    assert.ok(chatStylesheet.headers.etag, 'chat stylesheet should expose an ETag');
    assert.match(chatStylesheet.text, /@import url\("chat-base\.css"\);/);
    assert.match(chatStylesheet.text, /@import url\("chat-sidebar\.css"\);/);
    assert.match(chatStylesheet.text, /@import url\("chat-messages\.css"\);/);
    assert.doesNotMatch(chatStylesheet.text, /chat-workbench\.css/);
    assert.match(chatStylesheet.text, /@import url\("chat-run-sheet\.css"\);/);
    assert.match(chatStylesheet.text, /@import url\("right-sidebar\.css"\);/);
    assert.match(chatStylesheet.text, /@import url\("workspace-file-reader\.css"\);/);
    assert.match(chatStylesheet.text, /@import url\("chat-input\.css(?:\?[^"\)]*)?"\);/);
    assert.match(chatStylesheet.text, /@import url\("chat-responsive\.css"\);/);

    const rewrittenChatStylesheet = await request(port, 'GET', '/chat/chat.css?v=cache-bust-test');
    assert.equal(rewrittenChatStylesheet.status, 200, 'versioned chat stylesheet should load');
    assert.match(
      rewrittenChatStylesheet.text,
      /@import url\("chat-input\.css\?v=cache-bust-test"\);/,
      'versioned chat stylesheet should fingerprint the split composer stylesheet too',
    );

    const chatBaseStylesheet = await request(port, 'GET', '/chat/chat-base.css');
    const chatSidebarStylesheet = await request(port, 'GET', '/chat/chat-sidebar.css');
    const chatMessagesStylesheet = await request(port, 'GET', '/chat/chat-messages.css');
    const chatRunSheetStylesheet = await request(port, 'GET', '/chat/chat-run-sheet.css');
    const rightSidebarStylesheet = await request(port, 'GET', '/chat/right-sidebar.css');
    const workspaceFileReaderStylesheet = await request(port, 'GET', '/chat/workspace-file-reader.css');
    const chatInputStylesheet = await request(port, 'GET', '/chat/chat-input.css');
    const chatResponsiveStylesheet = await request(port, 'GET', '/chat/chat-responsive.css');
    const chatGlassStylesheet = await request(port, 'GET', '/chat/chat-glass.css');
    const liveStatusStylesheet = await request(port, 'GET', '/chat/chat-live-status.css');
    const crossDevicePanelStylesheet = await request(port, 'GET', '/chat/cross-device-panel.css');
    const operationalSurfacesStylesheet = await request(port, 'GET', '/chat/chat-operational-surfaces.css');
    const materialFinishStylesheet = await request(port, 'GET', '/chat/chat-material-finish.css');
    for (const stylesheet of [chatBaseStylesheet, chatSidebarStylesheet, chatMessagesStylesheet, chatRunSheetStylesheet, rightSidebarStylesheet, workspaceFileReaderStylesheet, chatInputStylesheet, chatResponsiveStylesheet, chatGlassStylesheet, liveStatusStylesheet, crossDevicePanelStylesheet, operationalSurfacesStylesheet, materialFinishStylesheet]) {
      assert.equal(stylesheet.status, 200, 'split chat stylesheet should load');
      assert.equal(
        stylesheet.headers['cache-control'],
        'public, no-cache, max-age=0, must-revalidate',
        'split chat stylesheet should use safe revalidation caching',
      );
      assert.ok(stylesheet.headers.etag, 'split chat stylesheet should expose an ETag');
    }
    const combinedChatStyles = [
      chatBaseStylesheet.text,
      chatSidebarStylesheet.text,
      chatMessagesStylesheet.text,
      chatRunSheetStylesheet.text,
      rightSidebarStylesheet.text,
      workspaceFileReaderStylesheet.text,
      chatInputStylesheet.text,
      chatResponsiveStylesheet.text,
      chatGlassStylesheet.text,
      operationalSurfacesStylesheet.text,
    ].join('\n');
    const systemDarkThemeBlock = chatBaseStylesheet.text.match(/@media \(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\n\s*\}\s*\n\}/);
    assert.ok(systemDarkThemeBlock, 'system dark theme variables should be present');
    assert.match(systemDarkThemeBlock[1], /--chat-area-bg:\s*#202123;/, 'system dark mode should use a dark chat background');
    assert.doesNotMatch(systemDarkThemeBlock[1], /--chat-area-bg:\s*#fff(?:fff)?;/i, 'system dark mode should not force a white chat background');
    const explicitDarkThemeBlock = chatBaseStylesheet.text.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
    assert.ok(explicitDarkThemeBlock, 'explicit dark theme variables should be present');
    assert.match(explicitDarkThemeBlock[1], /--chat-area-bg:\s*#1e1e1e;/, 'explicit dark theme should use a dark chat background');
    assert.doesNotMatch(explicitDarkThemeBlock[1], /--chat-area-bg:\s*#fff(?:fff)?;/i, 'explicit dark theme should not force a white chat background');
    assert.match(materialFinishStylesheet.text, /@media \(prefers-color-scheme:\s*dark\)\s*\{[\s\S]*?:root:not\(\[data-theme="light"\]\):not\(\[data-theme="amber"\]\) \.modal\s*\{[\s\S]*?background:\s*#18181b !important;/, 'modal dark surfaces should only apply when system dark mode is active');
    assert.doesNotMatch(materialFinishStylesheet.text, /:root:not\(\[data-theme="light"\]\) \.modal\s*\{/, 'an unspecified system-light theme must keep modal surfaces light');
    assert.match(crossDevicePanelStylesheet.text, /@media \(prefers-color-scheme:\s*dark\)\s*\{[\s\S]*?:root:not\(\[data-theme="light"\]\):not\(\[data-theme="amber"\]\) \.cross-device-sheet\s*\{[\s\S]*?background:\s*#18181b;/, 'cross-device sheets should respect system light mode');
    assert.match(combinedChatStyles, /button,\s*\[role="button"\],\s*input\[type="button"\],\s*input\[type="submit"\],\s*input\[type="reset"\],\s*summary\s*\{[\s\S]*?-webkit-tap-highlight-color:\s*transparent;/, 'all button-like controls should suppress the browser blue tap rectangle');
    assert.match(combinedChatStyles, /button:focus:not\(:focus-visible\),\s*\[role="button"\]:focus:not\(:focus-visible\),\s*input\[type="button"\]:focus:not\(:focus-visible\),\s*input\[type="submit"\]:focus:not\(:focus-visible\),\s*input\[type="reset"\]:focus:not\(:focus-visible\),\s*summary:focus:not\(:focus-visible\)\s*\{[\s\S]*?outline:\s*none;/, 'mouse and touch button focus should not draw the default blue rectangle');
    assert.match(combinedChatStyles, /\.header-btn,\s*\.sidebar-tab,\s*\.new-session-btn,\s*\.session-action-btn,\s*\.session-item,\s*\.folder-group-header,\s*\.archived-section-header\s*\{[\s\S]*?-webkit-tap-highlight-color:\s*transparent;/, 'sidebar interactions should suppress the mobile tap highlight flash');
    assert.match(combinedChatStyles, /--app-height:\s*100dvh/);
    assert.match(combinedChatStyles, /--keyboard-inset-height:\s*0px/);
    assert.match(combinedChatStyles, /--chat-bottom-overlay-height:\s*0px/);
    assert.match(combinedChatStyles, /--chat-floating-status-fab-offset:\s*0px/);
    assert.match(combinedChatStyles, /--chat-scrollbar-rail-width:\s*0px/);
    assert.match(combinedChatStyles, /--scrollbar-size:\s*10px/);
    assert.match(combinedChatStyles, /\*\s*\{[\s\S]*?scrollbar-width:\s*thin;[\s\S]*?scrollbar-color:\s*var\(--scrollbar-thumb\) var\(--scrollbar-track\);/, 'chat scroll containers should share a themed Firefox scrollbar style');
    assert.match(combinedChatStyles, /\*::-webkit-scrollbar\s*\{[\s\S]*?width:\s*var\(--scrollbar-size\);[\s\S]*?height:\s*var\(--scrollbar-size\);/, 'chat scroll containers should share a themed WebKit scrollbar size');
    assert.match(combinedChatStyles, /\*::-webkit-scrollbar-thumb\s*\{[\s\S]*?border:\s*3px solid transparent;[\s\S]*?border-radius:\s*999px;[\s\S]*?background:\s*var\(--scrollbar-thumb\);[\s\S]*?background-clip:\s*padding-box;/, 'chat scrollbars should render rounded padded thumbs');
    assert.match(combinedChatStyles, /--sidebar-width-expanded:\s*min\(80vw, calc\(100vw - 240px\)\);/);
    assert.match(chatResponsiveStylesheet.text, /@media \(min-width:\s*768px\)\s*\{\s*:root\s*\{[\s\S]*?--chat-scrollbar-rail-width:\s*12px;/, 'desktop and tablet layouts should reserve a visible rail for the full-height message scrollbar');
    assert.match(combinedChatStyles, /\.app-shell\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?grid-template-rows:\s*auto minmax\(0, 1fr\);/, 'app shell should reserve a fixed header row and a flexible body row');
    assert.match(combinedChatStyles, /\.app-container\s*\{[\s\S]*?min-height:\s*0;/);
    assert.match(combinedChatStyles, /@media \(min-width:\s*768px\)\s*\{[\s\S]*?\.header,\s*\.app-container\s*\{[\s\S]*?margin-left:\s*var\(--sidebar-width\);[\s\S]*?\.sidebar-overlay\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0 auto 0 0;[\s\S]*?height:\s*var\(--app-height,\s*100dvh\);/, 'desktop sidebar should pin to the top of the viewport while the header and content shift right');
    assert.doesNotMatch(combinedChatStyles, /var\(--workbench-width\)/, 'the retired audit column should not reserve desktop layout width');
    assert.match(combinedChatStyles, /body\.right-sidebar-open \.app-container\s*\{[\s\S]*?grid-template-columns:\s*minmax\(420px, 1fr\) var\(--right-sidebar-width\);/, 'desktop workspace sidebar should take a real grid column and squeeze chat instead of overlaying it');
    assert.match(combinedChatStyles, /\.app-container\s*\{[\s\S]*?transition:\s*grid-template-columns var\(--motion-panel\) var\(--motion-ease-standard\);/, 'desktop workspace sidebar should animate shell column changes');
    assert.match(chatRunSheetStylesheet.text, /@media \(min-width:\s*768px\)\s*\{[\s\S]*?\.run-sheet\s*\{[\s\S]*?left:\s*50%;[\s\S]*?top:\s*calc\(.*?\);[\s\S]*?width:\s*min\([0-9]+px, calc\(100vw - 48px\)\);/, 'desktop Run Sheet should expand from the top Live Bar into the upper screen');
    assert.match(combinedChatStyles, /@media \(min-width:\s*1180px\)\s*\{[\s\S]*?\.right-sidebar\s*\{[\s\S]*?position:\s*relative;[\s\S]*?grid-column:\s*2;[\s\S]*?width:\s*var\(--right-sidebar-width/, 'desktop workspace sidebar should live in the auxiliary shell column');
    assert.match(combinedChatStyles, /\.right-sidebar\s*\{[\s\S]*?pointer-events:\s*none;[\s\S]*?transform:\s*translateX\(100%\);/, 'workspace sidebar should keep a closed state that can animate before becoming hidden');
    assert.match(combinedChatStyles, /body\.right-sidebar-open \.right-sidebar\s*\{[\s\S]*?pointer-events:\s*auto;[\s\S]*?transform:\s*translateX\(0\);/, 'workspace sidebar should animate into an interactive open state');
    assert.match(combinedChatStyles, /\.right-sidebar-resize-handle\s*\{[\s\S]*?cursor:\s*ew-resize;/, 'desktop workspace sidebar should expose a horizontal resize handle');
    assert.match(combinedChatStyles, /\.workspace-file-reader-layout\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) minmax\(230px, var\(--workspace-file-reader-list-width, 32%\)\);/, 'workspace file reader should size the file list column from a resizable CSS variable');
    assert.match(combinedChatStyles, /\.workspace-file-reader-list-resize-handle\s*\{[\s\S]*?cursor:\s*ew-resize;/, 'workspace file reader should expose a file-list resize handle');
    assert.match(combinedChatStyles, /\.workspace-file-reader-view-enter\s*\{[\s\S]*?animation:\s*sidebar-surface-enter var\(--motion-base\) var\(--motion-ease-out\);/, 'workspace file reader sidebar views should animate when entering');
    assert.match(combinedChatStyles, /\.workspace-file-reader--reading \.workspace-file-reader-list-panel\s*\{[\s\S]*?display:\s*none;/, 'file reader reading mode should hide the file tree panel');
    assert.match(combinedChatStyles, /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.workspace-file-reader-layout\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;[\s\S]*?\.workspace-file-reader-preview\s*\{[\s\S]*?display:\s*none;[\s\S]*?flex:\s*1;[\s\S]*?\.workspace-file-reader--reading \.workspace-file-reader-preview\s*\{[\s\S]*?display:\s*block;[\s\S]*?\.workspace-file-reader-list-panel\s*\{[\s\S]*?flex:\s*1;[\s\S]*?border-top:\s*0;/, 'mobile workspace file reader should show the file tree and readable preview as mutually exclusive full-panel pages');
    assert.match(combinedChatStyles, /\.workspace-file-reader--embedded \.workspace-file-reader-header\s*\{[\s\S]*?grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/, 'embedded file reader header should reserve space for the reading-mode back chevron');
    assert.match(combinedChatStyles, /\.md-content \.markdown-math--display\s*\{[\s\S]*?overflow-x:\s*auto;[\s\S]*?text-align:\s*center;/, 'Markdown math display blocks should render as scrollable centered formulas');
    assert.match(combinedChatStyles, /\.chat-area\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0, 1fr\) auto auto;[\s\S]*?min-height:\s*0;/, 'chat area should keep the composer overlay row stable');
    assert.match(combinedChatStyles, /\.messages\s*\{[\s\S]*?grid-row:\s*1 \/ -1;[\s\S]*?overflow-y:\s*auto;[\s\S]*?padding:\s*0 var\(--chat-edge\) calc\(20px \+ var\(--chat-bottom-overlay-height,\s*0px\)\);[\s\S]*?scrollbar-gutter:\s*stable;/, 'message scroll container should span the full chat area and reserve bottom composer space');
    assert.match(combinedChatStyles, /\.messages::before\s*\{[\s\S]*?height:\s*calc\(var\(--app-header-height\) \+ var\(--safe-top\) \+ 20px\);/, 'message scroll container should reserve top header space with a stable spacer');
    assert.match(combinedChatStyles, /\.input-area\s*\{[\s\S]*?grid-row:\s*3;[\s\S]*?z-index:\s*3;[\s\S]*?margin-right:\s*var\(--chat-scrollbar-rail-width\);/, 'composer overlay should leave the right scrollbar rail uncovered');
    assert.match(page.text, /<div class="chat-status-header" id="chatStatusHeader"[\s\S]*?<div id="liveBar" class="live-bar chat-status-control"[\s\S]*?<div class="queued-panel" id="queuedPanel"><\/div>[\s\S]*?<div class="input-config-row" id="inputConfigRow">/, 'the Live Bar should live in the fixed top status header while the queued panel stays in the composer stack');
    assert.doesNotMatch(page.text, /id="liveBarSlot"/, 'the shipped chat template should not retain the retired bottom Live Bar slot');
    assert.match(combinedChatStyles, /\.queued-panel\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*calc\(100% \+ var\(--chat-floating-status-gap,\s*8px\)\);[\s\S]*?margin:\s*0 var\(--chat-gutter\);[\s\S]*?background:\s*transparent;/, 'queued panel should float above the composer and align with the Live Bar');
    assert.match(combinedChatStyles, /\.scroll-to-bottom-fab\s*\{[\s\S]*?bottom:\s*calc\(100% \+ var\(--chat-floating-status-fab-offset,\s*0px\) \+ 12px\);/, 'scroll-to-latest FAB should clear the complete floating status stack');
    assert.match(chatMessagesStylesheet.text, /\.input-stack:has\(\.live-bar\[data-collapsed="capsule"\]:not\(\[hidden\]\)\) \.scroll-to-bottom-fab\s*\{[\s\S]*?bottom:\s*calc\([\s\S]*?var\(--chat-queued-panel-stack-height,\s*0px\)[\s\S]*?var\(--chat-floating-status-gap,\s*8px\)/, 'scroll-to-latest FAB should align with a visible Live Bar capsule instead of floating above it');
    assert.match(chatMessagesStylesheet.text, /@keyframes scroll-to-bottom-fab-collapse[\s\S]*?transform: translateY\(calc\(0px - var\(--chat-live-bar-fab-fold-offset\)\)\)[\s\S]*?@keyframes scroll-to-bottom-fab-expand[\s\S]*?transform: translateY\(calc\(var\(--chat-live-bar-fab-fold-offset\) - 12px\)\)/, 'capsule fold/expand should animate the FAB position with the Live Bar shell');
    assert.match(chatMessagesStylesheet.text, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.input-stack:has\(\.live-bar\[data-capsule-motion="collapsing"\]\[data-collapsed="capsule"\]\) \.scroll-to-bottom-fab,[\s\S]*?animation:\s*none;/, 'reduced motion should disable the capsule FAB position animation');
    assert.match(liveStatusStylesheet.text, /\.live-bar-slot\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*calc\([\s\S]*?var\(--chat-queued-panel-stack-height,\s*0px\)[\s\S]*?\);/, 'Live Bar slot should float above the queued panel stack');
    assert.doesNotMatch(combinedChatStyles, /\.queued-panel\s*\{[\s\S]*?grid-row:\s*2;/, 'queued panel should no longer sit above the Live Bar as a separate chat-area grid row');
    assert.match(chatResponsiveStylesheet.text, /\.messages\s*\{[\s\S]*?padding-bottom:\s*calc\(28px \+ var\(--chat-bottom-overlay-height,\s*0px\)\);/, 'desktop message padding should keep composer clearance when the scrollbar spans full height');
    assert.match(chatResponsiveStylesheet.text, /body\.keyboard-open \.messages\s*\{[\s\S]*?padding-bottom:\s*calc\(12px \+ var\(--chat-bottom-overlay-height,\s*0px\)\);/, 'keyboard mode should preserve composer clearance instead of hiding the latest messages');
    assert.match(chatResponsiveStylesheet.text, /@media \(min-width:\s*1180px\)\s*\{[\s\S]*?\.chat-area\s*\{[\s\S]*?background:\s*var\(--chat-area-bg,\s*#fff\);/, 'desktop chat area should not override the themed chat surface with the app shell background');
    assert.doesNotMatch(page.text, /id="desktopRunStrip"/, 'desktop chat shell should not duplicate the header status strip inside the chat column');
    assert.doesNotMatch(combinedChatStyles, /\.queued-panel\s*\{[^}]*margin(?:-bottom)?:[^;}]*-[0-9]+px/, 'queued steer panel should not use a negative margin that can overlap the composer input');
    assert.match(chatResponsiveStylesheet.text, /\.queued-panel\s*\{[\s\S]*?margin-bottom:\s*0;/, 'hidden queued panel should not leave a visible gap above the composer');
    assert.match(chatInputStylesheet.text, /\.queued-panel\.visible\s*\{[\s\S]*?margin-bottom:\s*0;/, 'queued panel should float without reserving composer flow space while visible');
    assert.match(chatResponsiveStylesheet.text, /\.queued-panel\.visible\s*\{[\s\S]*?margin-bottom:\s*0;/, 'responsive queued panel should keep floating instead of reserving composer flow space');
    assert.doesNotMatch(chatResponsiveStylesheet.text, /\.queued-panel\s*\{\s*margin-bottom:\s*8px;\s*\}/, 'desktop queued panel should not create an empty grey strip when hidden');
    assert.match(combinedChatStyles, /\.chat-area > \*\s*\{[\s\S]*?min-width:\s*0;/, 'chat-area grid children should be allowed to shrink horizontally instead of expanding the column');
    assert.match(combinedChatStyles, /\.messages\s*\{[\s\S]*?min-height:\s*0;/);
    assert.match(combinedChatStyles, /\.messages-inner\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;/, 'message column should stay bound to the available chat width');
    const assistantPlainRule = chatMessagesStylesheet.text.match(/(?:^|\n)\.msg-assistant\s*\{([\s\S]*?)\n\}/);
    assert.ok(assistantPlainRule, 'assistant message rule should exist');
    assert.doesNotMatch(assistantPlainRule[1], /\b(?:background|border|box-shadow)\s*:/, 'normal assistant prose should remain unboxed');
    assert.match(chatMessagesStylesheet.text, /\.msg-user-bubble\s*\{[\s\S]*?background:\s*var\(--user-bubble\);[\s\S]*?border:\s*1px solid transparent;[\s\S]*?box-shadow:\s*var\(--shadow-soft,/, 'user bubbles should use soft surface contrast instead of a hard default outline');
    assert.match(chatMessagesStylesheet.text, /\.msg-user\s*\{[\s\S]*?flex-direction:\s*column;[\s\S]*?align-items:\s*flex-end;/, 'user message rows should stack the attachment strip above the bubble');
    assert.match(chatMessagesStylesheet.text, /\.msg-user\s*>\s*\.msg-images\s*\{[\s\S]*?justify-content:\s*flex-end;/, 'sent attachment strips should align to the right edge independently of the bubble');
    assert.match(chatMessagesStylesheet.text, /\.msg-user-bubble\.msg-failed\s*\{[\s\S]*?border:\s*1px solid var\(--failed-message-border\);/, 'failed user bubbles should keep an explicit failure border');
    assert.match(chatMessagesStylesheet.text, /\.msg-action-btn\s*\{[\s\S]*?border:\s*1px solid transparent;[\s\S]*?background:\s*transparent;[\s\S]*?transition:\s*background 0\.15s ease, color 0\.15s ease, border-color 0\.15s ease;/, 'message action buttons should default to transparent low-border controls');
    assert.match(chatMessagesStylesheet.text, /\.msg-action-btn:focus-visible\s*\{[\s\S]*?outline:\s*2px solid color-mix\(in srgb, var\(--focus-border\) 26%, transparent\);/, 'message action buttons should keep an accessible focus-visible ring');
    assert.match(chatMessagesStylesheet.text, /\.live-operation-row\s*\{[\s\S]*?border:\s*1px solid transparent;[\s\S]*?background:\s*var\(--surface-soft,[\s\S]*?box-shadow:[\s\S]*?var\(--shadow-soft,[\s\S]*?inset 3px 0 0 color-mix\(in srgb, var\(--notice\) 38%, transparent\);/, 'live operation rows should use soft surfaces and a status accent instead of hard horizontal outlines');
    assert.match(chatMessagesStylesheet.text, /\.live-operation-row\.state-failed,\s*\.live-operation-row\.state-declined\s*\{[\s\S]*?inset 3px 0 0 color-mix\(in srgb, var\(--error\) 52%, transparent\);/, 'failed operation rows should keep a visible status accent');
    assert.match(chatMessagesStylesheet.text, /\.msg-images \.attachment-card\s*\{[\s\S]*?border:\s*1px solid transparent;[\s\S]*?background:\s*var\(--surface-soft,[\s\S]*?box-shadow:[\s\S]*?var\(--shadow-soft,[\s\S]*?var\(--divider-subtle\)/, 'message attachment cards should use soft surfaces instead of hard panel borders');
    assert.match(chatMessagesStylesheet.text, /\.delivery-card\s*\{[\s\S]*?padding:\s*0;[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;/, 'delivery cards should be a semantic wrapper without a second raised surface');
    assert.match(chatMessagesStylesheet.text, /\.delivery-card-files\s*\{[\s\S]*?background:\s*var\(--surface-soft,[\s\S]*?overflow:\s*hidden;/, 'multiple delivery files should share one restrained group surface');
    assert.match(combinedChatStyles, /\.delivery-card-files\s*\{[\s\S]*?var\(--glass-sheen\),[\s\S]*?color-mix\(in srgb, var\(--surface-glass-strong-base\) 68%, transparent\);[\s\S]*?backdrop-filter:\s*blur\(calc\(var\(--glass-blur\) \* 0\.77\)\) saturate\(1\.08\);/, 'delivery groups should enable composer-matched frosted blur when supported');
    assert.match(chatMessagesStylesheet.text, /\.delivery-card \.attachment-card\s*\{[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;/, 'delivery file rows should stay transparent inside the single group surface');
    assert.match(chatMessagesStylesheet.text, /\.tool-card\s*\{[\s\S]*?background:\s*var\(--surface-soft, var\(--tool-bg\)\); border:\s*1px solid transparent;[\s\S]*?box-shadow:/, 'tool cards should use soft message surfaces with only subtle inset structure');
    assert.doesNotMatch(page.text, /input-resize-handle/, 'the composer should not render a manual resize handle anymore');
    assert.match(page.text, /<div class="input-wrapper">\s*<!-- Attachment preview inside wrapper -->/, 'the composer wrapper should start with the attachment preview');
    assert.match(combinedChatStyles, /\.input-area\s*\{[\s\S]*?border-top:\s*none;/, 'composer should not draw an exterior divider when no queued steer strip is visible');
    assert.match(chatBaseStylesheet.text, /--surface-raised:\s*color-mix\(in srgb, var\(--bg-secondary\) 94%, var\(--bg\)\);/, 'chat theme should expose a raised surface token for low-border controls');
    assert.match(chatInputStylesheet.text, /\.input-wrapper\s*\{[\s\S]*?background:\s*var\(--surface-raised,\s*var\(--chat-area-bg,\s*#fff\)\);[\s\S]*?border:\s*1px solid transparent;[\s\S]*?box-shadow:\s*var\(--shadow-soft,/, 'composer input shell should use a raised low-border surface');
    assert.match(chatInputStylesheet.text, /\.input-actions-row\s*\{[\s\S]*?border-top:\s*0;[\s\S]*?background:\s*color-mix\(in srgb, var\(--surface-soft\) 48%, transparent\);[\s\S]*?box-shadow:\s*inset 0 1px 0 color-mix\(in srgb, var\(--divider-subtle\) 64%, transparent\);/, 'composer action row should use a subtle surface/inner-shadow separator instead of a hard top outline');
    assert.match(chatInputStylesheet.text, /\.composer-action-btn\s*\{[\s\S]*?border:\s*1px solid transparent;[\s\S]*?background:\s*color-mix\(in srgb, var\(--accent\) 7%, var\(--surface-soft,\s*var\(--bg-secondary\)\)\);[\s\S]*?box-shadow:\s*0 1px 3px/, 'secondary composer action buttons should be visibly separated from the white composer shell');
    assert.match(chatInputStylesheet.text, /\.composer-runtime-btn,\s*\.composer-runtime-model-btn,\s*\.composer-permission-btn\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?border:\s*1px solid transparent;[\s\S]*?background:\s*color-mix\(in srgb, var\(--accent\) 7%, var\(--surface-soft,\s*var\(--bg-secondary\)\)\);[\s\S]*?box-shadow:\s*0 1px 3px/, 'runtime/model/permission chips should use a visible soft tint and allow narrow-width shrinking');
    assert.match(chatInputStylesheet.text, /\.composer-runtime-btn span:first-child,\s*\.composer-runtime-model-btn span:first-child,\s*\.composer-permission-btn span:first-child\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?overflow:\s*hidden;[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/, 'runtime/model/permission chip labels should ellipsize instead of overflowing on narrow widths');
    assert.match(chatInputStylesheet.text, /\.composer-add-menu\s*\{[\s\S]*?border:\s*1px solid transparent;[\s\S]*?border-radius:\s*16px;[\s\S]*?background:\s*var\(--surface-glass-strong,\s*var\(--surface-raised,\s*var\(--bg\)\)\);[\s\S]*?box-shadow:\s*var\(--shadow-floating,\s*var\(--modal-shadow\)\);/, 'composer add menu should use the online floating surface contract');
    assert.match(chatInputStylesheet.text, /\.composer-runtime-menu,\s*\.composer-permission-menu\s*\{[\s\S]*?border:\s*1px solid transparent;[\s\S]*?border-radius:\s*16px;[\s\S]*?background:\s*var\(--surface-glass-strong,\s*var\(--surface-raised,\s*var\(--bg\)\)\);[\s\S]*?box-shadow:\s*var\(--shadow-floating,\s*var\(--modal-shadow\)\);/, 'composer runtime/permission menus should use the online floating surface contract');
    assert.match(chatInputStylesheet.text, /\.composer-runtime-view-header\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center;[\s\S]*?min-height:\s*42px;/, 'composer nested menu levels should use a stable aligned header row');
    assert.doesNotMatch(chatInputStylesheet.text, /\.composer-runtime-option-check\s*\{/, 'selected runtime options should not expose checkmark affordances');
    assert.doesNotMatch(chatInputStylesheet.text, /\.input-area\.is-pending-send\b/, 'pending send state should not be drawn on the composer input area');
    assert.doesNotMatch(chatInputStylesheet.text, /\.send-btn\.is-sending::before/, 'pending send state should not render a spinner on the send button');
    assert.doesNotMatch(chatInputStylesheet.text, /composer-send-spin/, 'send button spinner should not define a rotation animation');
    assert.match(chatInputStylesheet.text, /\.input-area\.run-active \.send-btn\s*\{[\s\S]*?visibility:\s*hidden;[\s\S]*?pointer-events:\s*none;/, 'running sessions should reserve but visually hide the send button at rest');
    assert.doesNotMatch(chatInputStylesheet.text, /body\.composer-input-focused[^{]*\.input-area\.run-active \.send-btn/, 'textarea focus alone must never reveal Send while a session runs (user decision 2026-08-06)');
    assert.doesNotMatch(chatInputStylesheet.text, /\.input-area\.run-active:focus-within \.send-btn\s*\{/, 'running sessions must not reveal the send button on any composer focus');
    assert.match(chatInputStylesheet.text, /\.input-area\.run-active\.has-attachments \.send-btn,[\s\S]*?\.input-area\.run-active\.has-draft \.send-btn\s*\{[\s\S]*?visibility:\s*visible;[\s\S]*?pointer-events:\s*auto;/, 'queued attachments and non-empty drafts should swap Send into the reserved corner slot');
    assert.match(chatInputStylesheet.text, /\.input-area\.composer-send-pending \.img-preview-strip\.has-images\s*\{[\s\S]*?max-height:\s*0;[\s\S]*?padding-top:\s*0;[\s\S]*?padding-bottom:\s*0;[\s\S]*?border-bottom-width:\s*0;[\s\S]*?pointer-events:\s*none;/, 'attachment previews should leave the compact shell while transport is pending');
    assert.match(chatResponsiveStylesheet.text, /html\.keyboard-open,[\s\S]*?body\.keyboard-open\s*\{[\s\S]*?overflow:\s*hidden !important;/, 'keyboard mode should keep the document fixed instead of allowing layout-viewport panning');
    assert.match(chatInputStylesheet.text, /\.input-stack:has\(\.scroll-to-bottom-fab\.visible\)[\s\S]*?\.queued-summary\s*\{[\s\S]*?width:\s*calc\(100% - 56px\);[\s\S]*?margin-right:\s*56px;/, 'the queue count summary should move left when the return-to-latest button appears');
    assert.match(chatInputStylesheet.text, /\.send-stop-slot\s*\{[\s\S]*?position:\s*relative;[\s\S]*?width:\s*36px;[\s\S]*?height:\s*36px;/, 'send and stop should share one reserved corner slot so they never coexist');
    assert.match(chatInputStylesheet.text, /\.composer-edit-cancel-btn\s*\{[\s\S]*?width:\s*36px;[\s\S]*?height:\s*36px;[\s\S]*?background:\s*var\(--color-action\);/, 'edit resend cancel should match the desktop send control size and treatment');
    assert.match(chatResponsiveStylesheet.text, /\.composer-edit-cancel-btn\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/, 'edit resend cancel should match the mobile send touch target');
    assert.match(chatInputStylesheet.text, /\.composer-fullscreen-submit-actions\s*\{[\s\S]*?display:\s*flex;[\s\S]*?gap:\s*8px;/, 'fullscreen edit cancel and send should stay in one compact action group');
    assert.match(chatInputStylesheet.text, /\.input-area\.run-active\.has-draft \.cancel-btn,[\s\S]*?\.input-area\.run-active\.has-attachments \.cancel-btn\s*\{[\s\S]*?visibility:\s*hidden;[\s\S]*?pointer-events:\s*none;/, 'Stop should yield the corner slot to a staged follow-up (draft/attachments)');
    assert.match(page.text, /<div class="send-stop-slot">\s*<button class="send-btn" id="sendBtn"/, 'the template should wrap send and stop in one shared corner slot');
    assert.match(page.text, /<button class="composer-edit-cancel-btn" id="composerEditCancelBtn"[\s\S]*?<div class="send-stop-slot">\s*<button class="send-btn" id="sendBtn"/, 'the template should place edit cancel immediately before the resend button');
    assert.match(page.text, /<div class="composer-fullscreen-submit-actions">\s*<button class="composer-edit-cancel-btn composer-fullscreen-edit-cancel" id="composerFullscreenEditCancelBtn"[\s\S]*?<button class="[^"]*composer-fullscreen-send[^"]*" id="composerFullscreenSendBtn"/, 'fullscreen edit cancel should sit immediately left of fullscreen resend');
    assert.match(chatInputStylesheet.text, /\.cancel-btn\s*\{[\s\S]*?background:\s*var\(--color-action\);/, 'the stop button should use the shared primary action role');
    assert.doesNotMatch(chatInputStylesheet.text, /\.cancel-btn\s*\{[\s\S]*?background:\s*#ef2424/, 'the stop button should not keep the red background');
    assert.doesNotMatch(combinedChatStyles, /\.input-resize-handle/, 'resize handle styles should be removed');
    assert.doesNotMatch(combinedChatStyles, /\.input-resize-pill/, 'resize pill styles should be removed');
    assert.match(combinedChatStyles, /\.input-area\.is-file-drag-over \.input-wrapper\s*\{[\s\S]*?border-color:\s*color-mix\(in srgb, var\(--focus-border\) 82%, transparent\);/, 'composer should visibly accept desktop file drags');
    assert.match(combinedChatStyles, /\.input-area\.is-file-drag-over \.input-wrapper::after\s*\{[\s\S]*?border:\s*1px dashed/, 'composer file-drag target should expose a dashed drop affordance');
    assert.match(chatInputStylesheet.text, /\.composer-markdown-editor\s*\{[\s\S]*?min-height:\s*calc\(1\.55em \* 1\);/, 'the empty composer should sit at a single line');
    assert.match(chatInputStylesheet.text, /\.composer-markdown-editor \.vditor-wysiwyg del\s*,[\s\S]*?text-decoration:\s*line-through;/, 'the Vditor-backed Web composer should expose a shared strikethrough presentation');
    assert.match(chatMessagesStylesheet.text, /\.md-content del\s*\{[\s\S]*?text-decoration:\s*line-through;/, 'read-only Markdown messages should expose a shared strikethrough presentation');
    assert.match(combinedChatStyles, /--app-header-height:\s*44px;/, 'top header should use the slimmer shared header height');
    assert.match(combinedChatStyles, /@media \(max-width:\s*767px\)\s*\{[\s\S]*?:root\s*\{[\s\S]*?--app-header-height:\s*52px;/, 'mobile chat header should keep the compact height in every conversation');
    assert.doesNotMatch(combinedChatStyles, /--app-bar-expanded-height|app-bar-collapsed/, 'mobile chat header should not retain the scroll-dependent expanded state');
    assert.doesNotMatch(page.text, /id="headerSubtitle"|header-subtitle-status\.js|app-bar-collapse\.js/, 'chat shell should not render or load the retired header subtitle and collapse behavior');
    assert.match(combinedChatStyles, /\.header\s*\{[\s\S]*?height:\s*calc\(var\(--app-header-height\) \+ var\(--safe-top\)\);/, 'chat header height should follow the shared slim header token');
    assert.match(combinedChatStyles, /\.header-overflow-menu\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?top:\s*calc\(var\(--app-header-height\) \+ var\(--safe-top\) \+ 8px\);/, 'header overflow menu should stay visible when the header clips long titles');
    assert.doesNotMatch(page.text, /id="status(?:Dot|Text)"/, 'chat shell should not render the header session status label or status light');
    assert.doesNotMatch(combinedChatStyles, /\.status-dot|#statusText|status-breathe/, 'chat styles should not keep header session status or breathing-light CSS');
    assert.match(combinedChatStyles, /\.header-btn--sessions\s*\{[\s\S]*?width:\s*34px;[\s\S]*?min-width:\s*34px;[\s\S]*?padding:\s*0;[\s\S]*?background:\s*color-mix\(in srgb, var\(--bg-secondary\) 92%, var\(--bg\)\);[\s\S]*?color:\s*var\(--text\);/, 'session entry should be a light gray icon-only button');
    assert.match(combinedChatStyles, /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.header-btn--sessions\s*\{[\s\S]*?width:\s*40px;[\s\S]*?background:\s*color-mix\(in srgb, var\(--bg-secondary\) 92%, var\(--bg\)\);/, 'mobile session entry button should stay a compact light gray icon surface');
    assert.match(chatRunSheetStylesheet.text, /\.run-sheet\s*\{[\s\S]*?top:\s*calc\(var\(--app-header-height[\s\S]*?max-height:\s*var\(--run-sheet-expanded-height\);/, 'mobile Run Sheet should expand downwards from top header');
    assert.match(chatRunSheetStylesheet.text, /\.run-sheet__content\s*\{[\s\S]*?overflow-y:\s*auto;[\s\S]*?overscroll-behavior:\s*contain;/, 'Run Sheet content should own scrolling on every viewport');
    assert.doesNotMatch(combinedChatStyles, /\.workbench-inspector|\.workbench-review-unknown/, 'retired audit UI styles should not load into the chat shell');
    assert.match(combinedChatStyles, /\.sidebar-tabs\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);[\s\S]*?isolation:\s*isolate;/, 'sidebar tabs should use a three-way segmented layout instead of flex dividers');
    assert.match(chatSidebarStylesheet.text, /\/\* ---- ChatGPT-style sidebar polish ---- \*\/[\s\S]*?\.sidebar\s*\{[\s\S]*?border-right:\s*1px solid transparent;[\s\S]*?background:\s*var\(--surface-raised,[\s\S]*?box-shadow:\s*inset -1px 0 0 color-mix\(in srgb, var\(--divider-subtle\) 72%, transparent\);/, 'sidebar shell should use a raised soft surface instead of a hard divider');
    assert.match(chatSidebarStylesheet.text, /\.sidebar-search-input,\s*\.sidebar-workspace-select,\s*\.settings-inline-input,\s*\.settings-inline-select,\s*\.settings-inline-textarea\s*\{[\s\S]*?border:\s*1px solid transparent;[\s\S]*?background:\s*var\(--surface-soft, var\(--bg\)\);[\s\S]*?box-shadow:\s*inset 0 0 0 1px var\(--divider-subtle, transparent\);/, 'sidebar search, workspace, and settings inputs should use soft inset surfaces');
    assert.match(chatSidebarStylesheet.text, /\.sidebar-search-input:focus,\s*\.sidebar-workspace-select:focus,\s*\.settings-inline-input:focus,\s*\.settings-inline-select:focus,\s*\.settings-inline-textarea:focus\s*\{[\s\S]*?box-shadow:[\s\S]*?var\(--focus-border\) 16%[\s\S]*?var\(--focus-border\) 36%/, 'sidebar controls should keep clear focus rings after border softening');
    assert.match(combinedChatStyles, /\.sidebar-tabs\s*\{[\s\S]*?padding:\s*3px;[\s\S]*?border:\s*1px solid transparent;[\s\S]*?background:\s*var\(--surface-soft, color-mix\(in srgb, var\(--accent-dim\) 82%, var\(--bg-secondary\)\)\);[\s\S]*?box-shadow:[\s\S]*?var\(--shadow-soft,/, 'sidebar tab shell should render as a soft segmented control');
    assert.match(combinedChatStyles, /\.sidebar-tabs::before\s*\{[\s\S]*?width:\s*calc\(\(100% - 6px\) \/ 3\);[\s\S]*?background:\s*var\(--surface-raised, var\(--bg-secondary\)\);[\s\S]*?transform:\s*translateX\(calc\(var\(--sidebar-tab-index\) \* 100%\)\);/, 'sidebar tab selection should use a sliding raised selected surface');
    assert.match(chatSidebarStylesheet.text, /@media \(prefers-color-scheme:\s*dark\)\s*\{[\s\S]*?:root:not\(\[data-theme\]\) \.sidebar-tabs\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--bg\) 70%, var\(--bg-secondary\)\);[\s\S]*?:root:not\(\[data-theme\]\) \.sidebar-tabs::before\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--bg-secondary\) 86%, #ffffff\);[\s\S]*?:root:not\(\[data-theme\]\) \.sidebar-tab\.active\s*\{[\s\S]*?color:\s*#ffffff;/, 'system dark sidebar tab selected button should be lighter than the shell');
    assert.match(chatSidebarStylesheet.text, /:root\[data-theme="dark"\] \.sidebar-tabs\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--bg\) 70%, var\(--bg-secondary\)\);[\s\S]*?:root\[data-theme="dark"\] \.sidebar-tabs::before\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--bg-secondary\) 86%, #ffffff\);[\s\S]*?:root\[data-theme="dark"\] \.sidebar-tab\.active\s*\{[\s\S]*?color:\s*#ffffff;/, 'explicit dark sidebar tab selected button should be lighter than the shell');
    assert.match(chatSidebarStylesheet.text, /\.sidebar-tabs\s*\{[\s\S]*?box-sizing:\s*border-box;[\s\S]*?width:\s*calc\(100% - 16px\);[\s\S]*?margin:\s*8px auto;/, 'sidebar tab shell should be centered in the sessions panel by default');
    assert.match(combinedChatStyles, /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.sidebar\s*\{[\s\S]*?width:\s*100vw;/, 'mobile sessions panel should use a full-screen picker layout');
    assert.match(combinedChatStyles, /\.sidebar-close-btn\s*\{[\s\S]*?display:\s*none;[\s\S]*?\}/, 'sidebar close button should stay hidden until responsive sidebar chrome enables it');
    assert.match(combinedChatStyles, /@media \(min-width:\s*768px\)\s*\{[\s\S]*?\.sidebar-overlay:hover,\s*\.sidebar-overlay:focus-within\s*\{[\s\S]*?width:\s*calc\(var\(--sidebar-width\) \+ 48px\);[\s\S]*?\.sidebar-close-btn\s*\{[\s\S]*?top:\s*9px;[\s\S]*?right:\s*8px;[\s\S]*?border-radius:\s*10px;[\s\S]*?box-shadow:\s*0 1px 0 color-mix\(in srgb, var\(--bg\) 70%, transparent\) inset;[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*none;[\s\S]*?transform:\s*translateX\(-8px\) scale\(0\.96\);[\s\S]*?\.sidebar-overlay:hover \.sidebar-close-btn,[\s\S]*?\.sidebar:focus-within \.sidebar-close-btn,[\s\S]*?\.sidebar-close-btn:focus-visible\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;[\s\S]*?transform:\s*translateX\(0\) scale\(1\);/, 'desktop sidebar collapse control should appear inside the expanded sidebar next to the tab row');
    assert.match(combinedChatStyles, /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.sidebar-close-btn\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*calc\(12px \+ var\(--safe-top\)\);[\s\S]*?right:\s*12px;/, 'mobile sidebar close button should float on the same centerline as the top tabs');
    assert.match(combinedChatStyles, /@media \(min-width:\s*768px\)\s*\{[\s\S]*?\.sidebar-tabs\s*\{[\s\S]*?width:\s*calc\(100% - 16px\);[\s\S]*?margin:\s*7px auto;/, 'desktop sidebar tabs should stay visually centered instead of reserving a one-sided gutter');
    assert.match(combinedChatStyles, /@media \(min-width:\s*768px\)\s*\{[\s\S]*?\.sidebar-overlay:hover \.sidebar-tabs,\s*\.sidebar-overlay:focus-within \.sidebar-tabs\s*\{[\s\S]*?width:\s*calc\(var\(--sidebar-width\) - 16px\);[\s\S]*?margin-left:\s*8px;[\s\S]*?margin-right:\s*auto;/, 'desktop sidebar hover should keep the tab group at its normal width and reveal the chevron to its right');
    assert.match(combinedChatStyles, /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.sidebar-tabs\s*\{[\s\S]*?--sidebar-tab-index:\s*0;[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);[\s\S]*?width:\s*calc\(100% - 64px\);[\s\S]*?margin:\s*8px 56px 6px 8px;/, 'mobile sidebar tabs should hug the left edge while leaving only the close button lane on the right');
    assert.match(combinedChatStyles, /\.sidebar\[data-active-tab="agents"\] \.sidebar-tabs\s*\{[\s\S]*?--sidebar-tab-index:\s*1;/, 'mobile sidebar tab indicator should slide to Agent');
    assert.match(combinedChatStyles, /\.sidebar-tabs::before\s*\{[\s\S]*?transform:\s*translateX\(calc\(var\(--sidebar-tab-index\) \* 100%\)\);[\s\S]*?transition:\s*transform var\(--motion-panel\) var\(--motion-ease-emphasized\);/, 'mobile sidebar tabs should animate the selected pill across buttons');
    assert.match(combinedChatStyles, /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.sidebar-search\s*\{[\s\S]*?position:\s*relative;[\s\S]*?flex-shrink:\s*0;/, 'mobile sessions search should stay in normal sidebar flow instead of covering the list');
    assert.doesNotMatch(chatSidebarStylesheet.text, /\.sidebar-search\s*\{[^}]*position:\s*sticky;/, 'mobile sessions search should not use sticky positioning over the list');
    assert.match(combinedChatStyles, /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.session-item\.active\s*\{[\s\S]*?box-shadow:\s*none;/, 'mobile active sessions should use a flat selected surface without a left rail');
    assert.match(chatSidebarStylesheet.text, /\.session-item\.active\s*\{[\s\S]*?background:\s*var\(--surface-raised,[\s\S]*?border-color:\s*transparent;[\s\S]*?box-shadow:\s*var\(--shadow-soft,/, 'active session rows should use a raised soft surface');
    assert.match(chatSidebarStylesheet.text, /\.session-item\.active::before\s*\{[\s\S]*?left:\s*2px;[\s\S]*?width:\s*3px;[\s\S]*?background:\s*var\(--accent\);/, 'active session rows should retain the dedicated left accent rail restored for selected-row visibility');
    assert.doesNotMatch(chatSidebarStylesheet.text, /inset 3px 0 0 color-mix\(in srgb, var\(--accent\)/, 'active session rows should not use a left inset accent');
    assert.match(chatSidebarStylesheet.text, /\.new-session-btn\.secondary\s*\{[\s\S]*?border:\s*1px solid transparent;[\s\S]*?background:\s*var\(--surface-soft, var\(--bg-secondary\)\);[\s\S]*?box-shadow:\s*inset 0 0 0 1px var\(--divider-subtle, transparent\);/, 'secondary sidebar actions should use soft surfaces instead of hard borders');
    assert.match(chatSidebarStylesheet.text, /\.settings-group-card\s*\{[\s\S]*?(?:border:\s*0|border:\s*1px solid transparent;)[\s\S]*?background:\s*(?:color-mix\(in srgb, var\(--bg-secondary\)|var\(--surface-soft)/, 'sidebar settings cards should use soft surfaces instead of hard outlines');
    assert.match(chatSidebarStylesheet.text, /\.settings-row-button,\s*\.settings-app-btn\s*\{[\s\S]*?(?:border:\s*0|border:\s*1px solid transparent;)[\s\S]*?background:\s*var\(--surface-soft, var\(--bg\)\);/, 'sidebar icon and row buttons should use soft inset control surfaces');
    assert.match(combinedChatStyles, /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.new-session-btn\s*\{[\s\S]*?position:\s*static;[\s\S]*?flex-shrink:\s*0;/, 'mobile new session action should stay in the fixed sidebar action area without overlapping the list');
    assert.doesNotMatch(combinedChatStyles, /#sortSessionListBtn/, 'removed sort list button should not keep sidebar-specific styles');
    assert.match(combinedChatStyles, /\.sidebar-workspace-summary\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?color:\s*var\(--text\);[\s\S]*?font-size:\s*13px;[\s\S]*?font-weight:\s*650;[\s\S]*?text-align:\s*center;/, 'collapsed workspace summary should match the session-name size while using a bold weight');
    assert.match(combinedChatStyles, /\.sidebar-workspace\s*\{[\s\S]*?position:\s*relative;[\s\S]*?width:\s*calc\(100% - 24px\);[\s\S]*?padding:\s*7px 12px;[\s\S]*?border:\s*1px solid transparent;[\s\S]*?border-radius:\s*999px;/, 'workspace summary should remain a stable soft positioned anchor');
    assert.match(combinedChatStyles, /\.sidebar-workspace-summary:hover\s*\{[\s\S]*?color:\s*var\(--text\);/, 'collapsed workspace summary should stay black when hovered');
    assert.match(combinedChatStyles, /\.sidebar-workspace-summary::after\s*\{[\s\S]*?content:\s*none;/, 'collapsed workspace summary should not show a dropdown arrow');
    assert.match(combinedChatStyles, /\.sidebar-workspace-summary-text\s*\{[\s\S]*?display:\s*block;[\s\S]*?width:\s*100%;[\s\S]*?text-align:\s*center;[\s\S]*?white-space:\s*nowrap;/, 'collapsed workspace picker should show a horizontally centered single-line summary');
    assert.match(combinedChatStyles, /\.sidebar-workspace-popover\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?z-index:\s*41;[\s\S]*?top:\s*calc\(100% \+ 8px\);[\s\S]*?box-shadow:\s*var\(--modal-shadow\);/, 'workspace controls should float over the session list instead of changing sidebar layout');
    assert.match(combinedChatStyles, /\.sidebar-workspace-actions\s*\{[\s\S]*?display:\s*flex;[\s\S]*?justify-content:\s*flex-end;/, 'workspace popover should place confirmation at the lower right');
    assert.match(combinedChatStyles, /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.sidebar-workspace\s*\{[\s\S]*?position:\s*relative;[\s\S]*?display:\s*block;[\s\S]*?width:\s*calc\(100% - 24px\);[\s\S]*?border-radius:\s*999px;/, 'mobile workspace summary should stay a fixed rounded anchor');
    assert.match(combinedChatStyles, /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.sidebar-workspace-summary\s*\{[\s\S]*?font-size:\s*15px;/, 'mobile workspace text should match session-name typography');
    assert.match(combinedChatStyles, /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.sidebar-workspace-summary,[\s\S]*?\.sidebar-workspace-summary-text\s*\{[\s\S]*?display:\s*block;[\s\S]*?width:\s*100%;[\s\S]*?text-align:\s*center;/, 'mobile workspace text should stay centered inside the fixed row');
    assert.match(combinedChatStyles, /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.sidebar-workspace-summary\s*\{[\s\S]*?grid-column:\s*1 \/ -1;/, 'mobile workspace summary should span the full workspace row');
    assert.match(combinedChatStyles, /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.sidebar-section-note\s*\{[\s\S]*?display:\s*none;/, 'mobile workspace should hide explanatory note copy');
    assert.match(combinedChatStyles, /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.sidebar-workspace \.custom-select-wrap\.cs-full-bg \.cs-trigger\s*\{[\s\S]*?min-height:\s*36px;[\s\S]*?background:\s*var\(--surface-soft, var\(--bg\)\);/, 'mobile workspace custom selects should use the lighter sidebar control surface');
    assert.doesNotMatch(combinedChatStyles, /\.session-(?:item-meta|pin-badge|group-tag|source-tag|priority-tag|child-tag|item-count)\b/, 'session list metadata and tag styles should be removed from the sidebar');
    assert.match(combinedChatStyles, /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.settings-panel\s*\{[\s\S]*?padding:\s*8px 14px calc\(18px \+ var\(--safe-bottom\)\);/, 'mobile Agent and Settings panels should use mobile-specific padding');
    assert.match(combinedChatStyles, /\.sidebar\[data-sidebar-mode="agents"\] \.settings-panel#agentsPanel,[\s\S]*?#settingsPanel\s*\{[\s\S]*?background:\s*transparent;/, 'mobile Agent and Settings subpage panels should inherit the sidebar surface (transparent) instead of painting a chat-area background');
    assert.match(combinedChatStyles, /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.settings-section\s*\{[\s\S]*?border:\s*1px solid transparent;[\s\S]*?border-radius:\s*10px;[\s\S]*?background:\s*var\(--surface-soft, var\(--bg-secondary\)\);/, 'mobile settings sections should render as compact soft grouped surfaces');
    assert.match(combinedChatStyles, /#agentsPanel \.settings-section\s*\{[\s\S]*?background:\s*transparent;/, 'mobile Agent panel should not cover the sidebar canvas with a full-height gray section');
    assert.match(combinedChatStyles, /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.settings-app-card\s*\{[\s\S]*?border:\s*1px solid transparent;[\s\S]*?border-radius:\s*10px;[\s\S]*?background:\s*var\(--surface-raised, var\(--bg\)\);/, 'mobile Agent and connector cards should be compact and scan-friendly');
    assert.doesNotMatch(page.text, /id="agentsPanel"[\s\S]*?settings-section-title/, 'agents panel should not duplicate the subpage heading with an in-panel title');
    assert.match(page.text, /id="agentsPanel"[\s\S]*?settings-app-header[\s\S]*?settings-app-btn-primary/, 'agents panel header should pair the purpose note with a primary create button');
    assert.match(combinedChatStyles, /#agentsPanel \.settings-app-meta\s*\{[\s\S]*?display:\s*none;/, 'mobile Agent panel should hide low-value metadata text');
    assert.match(combinedChatStyles, /\.session-item-status\s*\{[\s\S]*?margin-left:\s*auto;/, 'session row status indicators should stay pinned to the far right');
    assert.match(combinedChatStyles, /\.session-item-status--running::before\s*\{[\s\S]*?border-top-color:[\s\S]*?animation:\s*session-item-status-ring\s+2\.4s\s+linear\s+infinite;/, 'running sessions should render a slow right-side ring motion without layout movement');
    assert.match(combinedChatStyles, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.session-item-status--running::before\s*\{\s*animation:\s*none;/, 'running ring motion should stop for reduced-motion users');
    assert.doesNotMatch(combinedChatStyles, /session-item-spin/, 'session rows should not keep the retired continuous spinner animation');
    assert.match(combinedChatStyles, /\.session-item-status--unread::before\s*\{[\s\S]*?background:\s*var\(--indicator-unread, #2563eb\);/, 'new session updates should render a dedicated right-side blue dot');
    assert.match(combinedChatStyles, /\.session-item-status--needs-action::before\s*\{[\s\S]*?background:\s*var\(--indicator-needs-action, #d97706\);/, 'sessions waiting on the user should render a dedicated right-side amber dot');
    assert.doesNotMatch(combinedChatStyles, /\.session-item(?:\.session-is-running)?::before\s*\{[\s\S]*?background:\s*(?:#fff|var\(--success\));/, 'mobile sessions should no longer use the old left-side run-state accent');
    assert.match(combinedChatStyles, /\.quick-entry-focus-btn\s*\{[\s\S]*?width:\s*100%;/, 'chat styles should expose a full-width quick-entry focus fallback button');
    assert.doesNotMatch(combinedChatStyles, /\.sidebar-overlay\.collapsed/, 'desktop sidebar should no longer render a collapsed state');
    assert.match(combinedChatStyles, /\.modal-backdrop\s*\{[\s\S]*?padding-left:\s*calc\(var\(--sidebar-width\) \+ 24px\);/, 'desktop modals should offset against the fixed-width sidebar');
    assert.match(combinedChatStyles, /body\.keyboard-open \.messages/);
    assert.match(combinedChatStyles, /body\.keyboard-open \.input-area/);
    assert.doesNotMatch(combinedChatStyles, /--app-top-offset/);
    assert.ok(!page.text.includes('/chat.js?v='), 'chat page should not pin the chat frontend to a versioned URL');
    assert.match(page.text, /<base href="\/">/, 'chat page should set an explicit product-base href');
    assert.match(page.text, /marked\.min\.js\?v=/, 'chat page should fingerprint marked.min.js alongside the split chat assets');
    assert.match(page.text, /chat\/markdown-math\.js\?v=/, 'chat page should load the local Markdown math renderer before split chat assets');
    assert.match(page.text, /manifest\.json\?v=/, 'chat page should fingerprint the manifest URL so installed PWAs refresh policy changes');
    assert.match(page.text, /id="composerAddMenu"/, 'chat page should expose a composer add menu');
    assert.match(page.text, /id="composerAttachFilesBtn"/, 'chat page should advertise file uploads from the add menu');
    assert.match(page.text, /class="composer-expanded-left-controls"[^>]*id="composerExpandedLeftControls"[^>]*hidden/, 'expanded-only left controls should have a shared hidden wrapper');
    assert.match(page.text, /id="composerRuntimeControls"[^>]*aria-label="Runtime controls"/, 'expanded-only runtime controls should remain grouped for animated presence');
    assert.match(page.text, /accept="\*\/\*"/, 'chat page should allow arbitrary file selection');

    const manifest = await request(port, 'GET', '/manifest.json');
    assert.equal(manifest.status, 200, 'manifest should load');
    const manifestJson = JSON.parse(manifest.text);
    assert.equal(manifestJson.id, './', 'manifest should declare a stable app id inside the current product scope');
    assert.equal(manifestJson.display, 'standalone', 'manifest should still advertise standalone install mode');
    assert.equal('orientation' in manifestJson, false, 'manifest should not force an orientation policy in the installed PWA shell');
    assert.equal(Array.isArray(manifestJson.shortcuts), true, 'manifest should advertise launcher shortcuts for installed Android PWAs');
    assert.equal(manifestJson.shortcuts.length, 1, 'manifest should keep the first quick-entry release to a single shortcut');
    assert.equal(manifestJson.shortcuts[0]?.name, '快速记录', 'manifest should expose the quick-entry shortcut label');
    assert.equal(manifestJson.shortcuts[0]?.url, './?intent=new-session', 'manifest shortcut should stay inside the current product scope');
    assert.deepEqual(
      [...new Set(manifestJson.icons.map((icon) => icon.src))],
      ['icon-192.png', 'icon-512.png'],
      'manifest should use only WebAPK-safe PNG installation icons',
    );
    assert.equal(
      manifestJson.icons.some((icon) => icon.sizes === 'any' || icon.type === 'image/svg+xml'),
      false,
      'manifest should not expose SVG or sizes:any icons that can stall Android WebAPK minting',
    );

    const prefixedPage = await request(port, 'GET', '/', null, { 'x-forwarded-prefix': '/owner' });
    assert.equal(prefixedPage.status, 200, 'chat page should still render behind a forwarded product prefix');
    assert.match(prefixedPage.text, /<base href="\/owner\/">/, 'chat page should advertise the forwarded product prefix through base href');
    assert.match(prefixedPage.text, /<link rel="manifest" href="manifest\.json\?v=/, 'chat page should keep the manifest link relative inside a prefixed surface');
    assert.match(prefixedPage.text, /<link rel="stylesheet" href="chat\/chat\.css\?v=/, 'chat page should keep the split stylesheet inside the forwarded product scope');
    assert.match(prefixedPage.text, /<script src="chat\/product-paths\.js(?:\?v=[^"]*)?"/, 'chat page should continue to load the product-path helper under a prefix');

    const loginPage = await request(port, 'GET', '/login', null, { Cookie: '' });
    assert.equal(loginPage.status, 200, 'login page should render without auth');
    assert.match(loginPage.text, /<meta name="color-scheme" content="light dark">/);
    assert.match(loginPage.text, /<meta name="application-name" content="Ragent">/);
    assert.match(loginPage.text, /<meta name="theme-color" content="#f8f8fa" media="\(prefers-color-scheme: light\)">/);
    assert.match(loginPage.text, /<meta name="theme-color" content="#161618" media="\(prefers-color-scheme: dark\)">/);
    assert.match(loginPage.text, /@media \(prefers-color-scheme: dark\)/);

    const prefixedLoginPage = await request(port, 'GET', '/login', null, {
      Cookie: '',
      'x-forwarded-prefix': '/owner',
    });
    assert.equal(prefixedLoginPage.status, 200, 'login page should still render behind a forwarded product prefix');
    assert.match(prefixedLoginPage.text, /<base href="\/owner\/">/, 'login page should advertise the forwarded product prefix through base href');
    assert.match(prefixedLoginPage.text, /<form id="pw-form" method="POST" action="login">/, 'login password form should stay inside the forwarded product scope');
    assert.match(prefixedLoginPage.text, /<form id="token-form" class="hidden" method="POST" action="login">/, 'login token form should stay inside the forwarded product scope');

    const agents = await request(port, 'GET', '/api/agents');
    assert.equal(agents.status, 200, 'owner agents endpoint should be available');
    const agentList = JSON.parse(agents.text);
    assert.ok(Array.isArray(agentList.agents), 'owner agents endpoint should return a collection');

    const legacyApps = await request(port, 'GET', '/api/apps');
    assert.equal(legacyApps.status, 404, 'legacy owner apps endpoint should be absent from the product surface');

    const users = await request(port, 'GET', '/api/users');
    assert.equal(users.status, 404, 'owner users endpoint should be absent from the product surface');

    const visitors = await request(port, 'GET', '/api/visitors');
    assert.equal(visitors.status, 404, 'owner visitors endpoint should be absent from the product surface');

    const legacyAgentShare = await request(port, 'GET', '/app/example-token', null, { Cookie: '' });
    assert.equal(legacyAgentShare.status, 404, 'legacy app share route should stay absent');

    const agentShare = await request(port, 'GET', '/agent/example-token', null, { Cookie: '' });
    assert.equal(agentShare.status, 302, 'interactive agent share route should be absent (falls through to the login redirect)');
    assert.equal(agentShare.headers.location, '/login', 'agent share path should redirect to login instead of serving share content');

    const visitorShare = await request(port, 'GET', '/visitor/example-token');
    assert.equal(visitorShare.status, 404, 'interactive visitor share route should be absent');

    const defaultOwnerCreated = await request(port, 'POST', '/api/sessions', {
      tool: 'codex',
      name: 'Owner default workspace session',
    });
    assert.equal(defaultOwnerCreated.status, 201, 'owner sessions should be creatable without an explicit folder');
    const defaultOwnerCreatedJson = JSON.parse(defaultOwnerCreated.text);
    assert.equal(defaultOwnerCreatedJson.session?.folder, join(home, '.ragent', 'workspace'), 'owner sessions without a folder should default to the managed work root');

    const createdChat = await request(port, 'POST', '/api/sessions', {
      folder: home,
      tool: 'codex',
      name: 'Owner chat session',
    });
    assert.equal(createdChat.status, 201, 'owner chat session should be creatable over HTTP');
    const createdChatJson = JSON.parse(createdChat.text);

    const createdGithub = await request(port, 'POST', '/api/sessions', {
      folder: home,
      tool: 'codex',
      name: 'GitHub session',
      sourceId: 'github',
      sourceName: 'GitHub',
    });
    assert.equal(createdGithub.status, 201, 'GitHub-source session should be creatable over HTTP');
    const createdGithubJson = JSON.parse(createdGithub.text);

    const pinned = await request(port, 'PATCH', `/api/sessions/${createdChatJson.session.id}`, {
      pinned: true,
    });
    assert.equal(pinned.status, 200, 'session pinning should be available over HTTP');
    assert.match(pinned.text, /"pinned":true/);

    const allSessions = await request(port, 'GET', '/api/sessions');
    assert.equal(allSessions.status, 200, 'full session list should load');
    const allSessionsJson = JSON.parse(allSessions.text);
    assert.equal(
      allSessionsJson.sessions?.[0]?.id,
      createdChatJson.session.id,
      'pinned session should sort to the top of the session list',
    );
    assert.equal(
      allSessionsJson.sessions?.some((session) => session.id === createdGithubJson.session.id),
      true,
      'other sessions should remain visible after pinning',
    );

    const githubOnly = await request(port, 'GET', '/api/sessions?sourceId=github');
    assert.equal(githubOnly.status, 200, 'source-filtered session list should load');
    assert.match(githubOnly.text, /"sourceId":"github"/);
    assert.match(githubOnly.text, /"sourceName":"GitHub"/);
    assert.doesNotMatch(githubOnly.text, /"name":"Owner chat session"/);

    const splitAsset = await request(port, 'GET', '/chat/bootstrap.js');
    assert.equal(splitAsset.status, 200, 'split chat asset should load');
    assert.equal(
      splitAsset.headers['cache-control'],
      'public, no-cache, max-age=0, must-revalidate',
      'split asset should use safe revalidation caching',
    );
    assert.ok(splitAsset.headers.etag, 'split asset should expose an ETag');
    assert.match(splitAsset.text, /const buildInfo = window\.__RAGENT_BUILD__ \|\| \{\};/);

    const initAsset = await request(port, 'GET', '/chat/init.js');
    assert.equal(initAsset.status, 200, 'chat init asset should load');
    assert.match(
      initAsset.text,
      /await openInstallFlow\(\{ source: "auto", replace: true \}\)/,
      'mobile install redirects should funnel through the shared install helper',
    );
    assert.match(initAsset.text, /window\.ragentOpenInstallFlow = openInstallFlow;/, 'chat init should expose the install entry helper');

    const productPathsAsset = await request(port, 'GET', '/chat/product-paths.js');
    assert.equal(productPathsAsset.status, 200, 'product path helper asset should load');
    assert.match(productPathsAsset.text, /function resolveProductPath\(/);
    assert.match(productPathsAsset.text, /ragentResolveProductPath = resolveProductPath/);

    const sessionHttpHelpersAsset = await request(port, 'GET', '/chat/session-http-helpers.js');
    assert.equal(sessionHttpHelpersAsset.status, 200, 'session http helpers asset should load');
    assert.match(sessionHttpHelpersAsset.text, /function enhanceRenderedContentLinks\(/);
    assert.match(sessionHttpHelpersAsset.text, /const SESSION_LIST_URL = "\/api\/sessions";/);

    const sessionHttpListStateAsset = await request(port, 'GET', '/chat/session-http-list-state.js');
    assert.equal(sessionHttpListStateAsset.status, 200, 'session http list state asset should load');
    assert.match(sessionHttpListStateAsset.text, /function applySessionListState\(/);
    assert.match(sessionHttpListStateAsset.text, /function applyArchivedSessionListState\(/);

    const sessionHttpAsset = await request(port, 'GET', '/chat/session-http.js');
    assert.equal(sessionHttpAsset.status, 200, 'session http asset should load');
    const sessionStoreAsset = await request(port, 'GET', '/chat/session-store.js');
    assert.equal(sessionStoreAsset.status, 200, 'session store asset should load');
    assert.match(sessionStoreAsset.text, /RagentChatStore/);
    const composerStoreAsset = await request(port, 'GET', '/chat/composer-store.js');
    assert.equal(composerStoreAsset.status, 200, 'composer store asset should load');
    assert.match(composerStoreAsset.text, /RagentComposerStore/);
    const bootstrapCatalogAsset = await request(port, 'GET', '/chat/bootstrap-session-catalog.js');
    assert.equal(bootstrapCatalogAsset.status, 200, 'bootstrap session catalog asset should load');
    assert.match(bootstrapCatalogAsset.text, /function getEffectiveSessionSourceId\(/);
    assert.match(bootstrapCatalogAsset.text, /function sortSessionsInPlace\(/);

    if (/getEffectiveSessionSourceId\(/.test(sessionHttpAsset.text)) {
      assert.match(
        bootstrapCatalogAsset.text,
        /function getEffectiveSessionSourceId\(/,
        'bootstrap session catalog asset should define the effective source helper used by session-http',
      );
    }

    const versionedSplitAsset = await request(port, 'GET', '/chat/bootstrap.js?v=test-build');
    assert.equal(versionedSplitAsset.status, 200, 'versioned split chat asset should load');
    assert.equal(
      versionedSplitAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned split assets should be immutable cache hits',
    );

    const versionedBootstrapCatalogAsset = await request(port, 'GET', '/chat/bootstrap-session-catalog.js?v=test-build');
    assert.equal(versionedBootstrapCatalogAsset.status, 200, 'versioned bootstrap session catalog asset should load');
    assert.equal(
      versionedBootstrapCatalogAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned bootstrap session catalog asset should be immutable cache hits',
    );

    const versionedSessionStoreAsset = await request(port, 'GET', '/chat/session-store.js?v=test-build');
    assert.equal(versionedSessionStoreAsset.status, 200, 'versioned session store asset should load');
    assert.equal(
      versionedSessionStoreAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned session store asset should be immutable cache hits',
    );

    const versionedComposerStoreAsset = await request(port, 'GET', '/chat/composer-store.js?v=test-build');
    assert.equal(versionedComposerStoreAsset.status, 200, 'versioned composer store asset should load');
    assert.equal(
      versionedComposerStoreAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned composer store asset should be immutable cache hits',
    );

    const versionedSessionHttpHelpersAsset = await request(port, 'GET', '/chat/session-http-helpers.js?v=test-build');
    assert.equal(versionedSessionHttpHelpersAsset.status, 200, 'versioned session http helpers asset should load');
    assert.equal(
      versionedSessionHttpHelpersAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned session http helpers asset should be immutable cache hits',
    );

    const versionedSessionHttpListStateAsset = await request(port, 'GET', '/chat/session-http-list-state.js?v=test-build');
    assert.equal(versionedSessionHttpListStateAsset.status, 200, 'versioned session http list state asset should load');
    assert.equal(
      versionedSessionHttpListStateAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned session http list state asset should be immutable cache hits',
    );

    const versionedLayoutToolingAsset = await request(port, 'GET', '/chat/layout-tooling.js?v=test-build');
    assert.equal(versionedLayoutToolingAsset.status, 200, 'versioned layout tooling asset should load');
    assert.equal(
      versionedLayoutToolingAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned layout tooling asset should be immutable cache hits',
    );

    const versionedRealtimeRenderAsset = await request(port, 'GET', '/chat/realtime-render.js?v=test-build');
    assert.equal(versionedRealtimeRenderAsset.status, 200, 'versioned realtime render asset should load');
    assert.equal(
      versionedRealtimeRenderAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned realtime render asset should be immutable cache hits',
    );

    const versionedChatStylesheet = await request(port, 'GET', '/chat/chat.css?v=test-build');
    assert.equal(versionedChatStylesheet.status, 200, 'versioned chat stylesheet should load');
    assert.equal(
      versionedChatStylesheet.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned chat stylesheet should be immutable cache hits',
    );
    assert.match(versionedChatStylesheet.text, /@import url\("chat-base\.css\?v=test-build"\);/);
    assert.match(versionedChatStylesheet.text, /@import url\("chat-sidebar\.css\?v=test-build"\);/);
    assert.match(versionedChatStylesheet.text, /@import url\("chat-messages\.css\?v=test-build"\);/);
    assert.match(versionedChatStylesheet.text, /@import url\("chat-input\.css\?v=[^"]+"\);/);
    assert.match(versionedChatStylesheet.text, /@import url\("chat-responsive\.css\?v=test-build"\);/);

    const versionedChatBaseStylesheet = await request(port, 'GET', '/chat/chat-base.css?v=test-build');
    assert.equal(versionedChatBaseStylesheet.status, 200, 'versioned split chat stylesheet should load');
    assert.equal(
      versionedChatBaseStylesheet.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned split chat stylesheet should be immutable cache hits',
    );

    const stateModelAsset = await request(port, 'GET', '/chat/session-state-model.js');
    assert.equal(stateModelAsset.status, 200, 'session state model asset should load');
    assert.equal(
      stateModelAsset.headers['cache-control'],
      'public, no-cache, max-age=0, must-revalidate',
      'session state model should use safe revalidation caching',
    );
    assert.ok(stateModelAsset.headers.etag, 'session state model asset should expose an ETag');
    assert.match(stateModelAsset.text, /RagentSessionStateModel/);

    const sessionStoreModelAsset = await request(port, 'GET', '/chat/session-store.js');
    assert.equal(sessionStoreModelAsset.status, 200, 'session store model asset should load');
    assert.equal(
      sessionStoreModelAsset.headers['cache-control'],
      'public, no-cache, max-age=0, must-revalidate',
      'session store model should use safe revalidation caching',
    );
    assert.ok(sessionStoreModelAsset.headers.etag, 'session store model asset should expose an ETag');
    assert.match(sessionStoreModelAsset.text, /RagentChatStore/);

    const composerStoreModelAsset = await request(port, 'GET', '/chat/composer-store.js');
    assert.equal(composerStoreModelAsset.status, 200, 'composer store model asset should load');
    assert.equal(
      composerStoreModelAsset.headers['cache-control'],
      'public, no-cache, max-age=0, must-revalidate',
      'composer store model should use safe revalidation caching',
    );
    assert.ok(composerStoreModelAsset.headers.etag, 'composer store model asset should expose an ETag');
    assert.match(composerStoreModelAsset.text, /RagentComposerStore/);

    const layoutToolingAsset = await request(port, 'GET', '/chat/layout-tooling.js');
    assert.equal(layoutToolingAsset.status, 200, 'layout tooling asset should load');
    assert.match(layoutToolingAsset.text, /document\.documentElement\.style\.setProperty\("--app-height"/);
    assert.match(layoutToolingAsset.text, /document\.documentElement\.style\.setProperty\("--keyboard-inset-height"/);
    assert.match(layoutToolingAsset.text, /function syncChatBottomOverlaySpacing\(reason = "layout",/);
    assert.match(layoutToolingAsset.text, /style\.setProperty\("--chat-bottom-overlay-height", `\$\{overlayHeight\}px`\)/, 'layout tooling should publish composer clearance for the full-height message scrollbar');
    assert.match(layoutToolingAsset.text, /new ResizeObserver\(\(\) => \{[\s\S]*?requestLayoutPass\("chat-bottom-overlay-resize"\);[\s\S]*?\}\)/, 'layout tooling should resync composer clearance when the overlay changes size');
    assert.match(layoutToolingAsset.text, /chatOverlayResizeObserver\.observe\(inputArea\)/, 'layout tooling should observe composer height changes');
    assert.match(layoutToolingAsset.text, /chatOverlayResizeObserver\.observe\(queuedPanel\)/, 'layout tooling should observe queued-panel height changes');
    assert.match(layoutToolingAsset.text, /const renderedLiveBarHeight = 0;[\s\S]*?const liveBarHeight = 0;/, 'layout tooling should keep top-header Live Bar height out of bottom overlay measurements');
    assert.match(layoutToolingAsset.text, /const floatingStatusGap = getFloatingStatusGapPx\(\);[\s\S]*?const queueStackHeight = queueHeight > 0[\s\S]*?queueHeight \+ floatingStatusGap/, 'layout tooling should reserve floating queued-panel height separately from composer height');
    assert.match(layoutToolingAsset.text, /const decisionSheetOpen = Boolean\(decisionSheet && !decisionSheet\.hidden\)/, 'layout tooling should detect the visible Decision Sheet before measuring the Live Bar');
    assert.match(layoutToolingAsset.text, /style\.setProperty\("--chat-decision-sheet-height"/, 'layout tooling should publish Decision Sheet height for diagnostics and spacing');
    assert.match(layoutToolingAsset.text, /observeOverlay\(element\)/, 'layout tooling should expose dynamic overlay registration');
    assert.match(layoutToolingAsset.text, /style\.setProperty\("--chat-floating-status-height", `\$\{Math\.ceil\(floatingStatusHeight\)\}px`\)/, 'layout tooling should publish floating status height for diagnostics and spacing');
    assert.match(layoutToolingAsset.text, /const floatingStatusFabOffset = floatingStatusHeight > 0[\s\S]*?floatingStatusHeight \+ floatingOffset/, 'layout tooling should derive a stack-aware FAB offset only when a floating status exists');
    assert.match(layoutToolingAsset.text, /style\.setProperty\("--chat-floating-status-fab-offset", `\$\{Math\.ceil\(floatingStatusFabOffset\)\}px`\)/, 'layout tooling should publish the stack-aware FAB offset');
    assert.doesNotMatch(layoutToolingAsset.text, /chatOverlayResizeObserver\.observe\(liveBarSlot\)/, 'layout tooling should not observe the retired bottom Live Bar slot');
    assert.match(layoutToolingAsset.text, /function requestLayoutPass\(/);
    assert.match(layoutToolingAsset.text, /window\.RagentLayout = \{/);
    assert.match(layoutToolingAsset.text, /syncChatBottomOverlaySpacing,/);
    assert.match(layoutToolingAsset.text, /window\.visualViewport\?\.addEventListener\("resize", \(\) => requestLayoutPass\("visual-viewport-resize"\)\)/);
    assert.match(layoutToolingAsset.text, /window\.visualViewport\?\.addEventListener\("scroll", \(\) => requestLayoutPass\("visual-viewport-scroll"\)\)/);
    assert.match(layoutToolingAsset.text, /function focusComposer\(/);

    const motionAsset = await request(port, 'GET', '/chat/motion.js');
    assert.equal(motionAsset.status, 200, 'motion helper asset should load');
    assert.match(motionAsset.text, /window\.RagentMotion\s*=\s*\{/);
    assert.match(motionAsset.text, /function setPresence\(/);

    const focusScopeAsset = await request(port, 'GET', '/chat/focus-scope.js');
    assert.equal(focusScopeAsset.status, 200, 'focus scope asset should load');
    assert.match(focusScopeAsset.text, /root\.RagentFocusScope\s*=\s*Object\.freeze/);
    assert.match(focusScopeAsset.text, /function activate\(/);

    const toolingAsset = await request(port, 'GET', '/chat/tooling.js');
    assert.equal(toolingAsset.status, 200, 'tooling asset should load');
    assert.match(toolingAsset.text, /const modelResponseCache = new Map\(\);/);
    assert.match(toolingAsset.text, /async function fetchModelResponse\(/);

    const realtimeRenderAsset = await request(port, 'GET', '/chat/realtime-render.js');
    assert.equal(realtimeRenderAsset.status, 200, 'realtime render asset should load');
    assert.match(realtimeRenderAsset.text, /function renderEvent\(/);
    assert.match(realtimeRenderAsset.text, /async function hydrateLazyNodes\(/);
    assert.match(realtimeRenderAsset.text, /currentSessionId !== sessionId/, 'deferred scroll work should not affect a newly selected session');
    assert.match(realtimeRenderAsset.text, /preserveNode: true/, 'final assistant messages should reuse the streaming node');

    const uiAsset = await request(port, 'GET', '/chat/ui.js');
    assert.equal(uiAsset.status, 200, 'ui asset should load');
    assert.match(uiAsset.text, /\/api\/media\//, 'ui asset should load persisted media attachments from the media route');
    assert.match(uiAsset.text, /prepareMarkdownMath/, 'Markdown rendering should protect math formulas before marked parses the source');
    assert.match(uiAsset.text, /renderMarkdownMathInNode/, 'Markdown rendering should restore math formulas after marked renders HTML');
    assert.match(uiAsset.text, /function renderFileChangeEditingStatusInto\(/, 'ui asset should use file-change events as thinking-line editing signals');
    assert.match(uiAsset.text, /function createAttachmentDeliveryCard\(/, 'chat stream should render attachment deliveries as a delivery card');
    assert.match(uiAsset.text, /evt\.type === "attachment_delivery"/, 'attachment delivery events should use the dedicated delivery-card render path');
    assert.doesNotMatch(uiAsset.text, /deliveryCard\.(?:eyebrow|title|summary)/, 'delivery cards should not render delivery labels, ready titles, or explanatory summaries');
    assert.match(uiAsset.text, /renderUiIcon\("file-download"\)/, 'attachment file cards should use the modern file-download icon');
    assert.match(uiAsset.text, /function renderMessageIntoStreamingNode\(/, 'final Markdown should settle into the existing streaming message node');
    assert.match(combinedChatStyles, /\.msg-assistant\.stream-settling\s*\{[^}]*?transition:[^}]*?opacity var\(--motion-base\)[^}]*?transform var\(--motion-base\)/, 'stream settlement should crossfade with compositor-only opacity and transform');
    assert.doesNotMatch(combinedChatStyles, /\.msg-assistant\.stream-settling\s*\{[^}]*?(?:height|will-change):/, 'stream settlement must never animate layout properties');
    assert.match(combinedChatStyles, /@keyframes code-block-form[\s\S]*?opacity:\s*0\.55/, 'settled code blocks should reveal with a restrained opacity-only forming animation');
    assert.match(combinedChatStyles, /\.md-content pre\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?overflow-x:\s*auto;[\s\S]*?white-space:\s*pre;/, 'Markdown code blocks should own horizontal scrolling instead of wrapping commands into unreadable fragments');
    assert.match(combinedChatStyles, /\.md-content \.code-block-wrap pre\s*\{[\s\S]*?overflow-x:\s*auto !important;[\s\S]*?-webkit-overflow-scrolling:\s*touch;/, 'the final code surface cascade should restore touch horizontal scrolling after shared overflow resets');
    assert.match(combinedChatStyles, /\.md-content \.code-block-wrap pre > code\s*\{[\s\S]*?display:\s*block;[\s\S]*?width:\s*max-content;[\s\S]*?white-space:\s*pre;/, 'long code lines should stay inside the pre viewport instead of widening the chat page');
    assert.match(combinedChatStyles, /\.md-content \.code-block-wrap\s*\{[\s\S]*?border-radius:\s*var\(--m3-shape-large,\s*16px\) !important;[\s\S]*?box-shadow:\s*0 10px 28px/, 'code blocks should use the shared soft, borderless floating surface');
    assert.match(combinedChatStyles, /\.md-content \.code-block-wrap\s*\{[\s\S]*?background:\s*#f1f2f4 !important;/, 'light code blocks should use a visible neutral-grey surface');
    assert.match(combinedChatStyles, /:root\[data-theme="dark"\] \.md-content \.code-block-wrap\s*\{[\s\S]*?background:\s*#252629 !important;/, 'dark code blocks should use a visible neutral-grey surface');
    assert.match(combinedChatStyles, /@keyframes code-copy-in[\s\S]*?translateY\(2px\) scale\(0\.94\)/, 'settled code copy buttons should pop in with a small compositor-only offset');
    assert.match(combinedChatStyles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.code-copy-btn[\s\S]*?animation:\s*none !important/, 'code block forming animations should be disabled under reduced motion');
    assert.match(combinedChatStyles, /\.messages-inner\.restoring-session-snapshot[\s\S]*?animation:\s*none !important/, 'restored session snapshots should not replay message entrance animations');
    assert.doesNotMatch(combinedChatStyles, /\.delivery-card-icon\b/, 'delivery cards should not include the old green status icon surface');
    assert.match(combinedChatStyles, /\.attachment-download-btn\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;/, 'attachment download buttons should be borderless icon controls');
    assert.match(chatMessagesStylesheet.text, /\.msg-images \.attachment-card \.attachment-file\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?width:\s*auto;[\s\S]*?min-width:\s*0;/, 'message attachment file shells should shrink beside the download action');
    assert.match(chatBaseStylesheet.text, /\.attachment-download-btn\.attachment-download-btn--icon,\s*\.run-sheet__reader-action\.run-sheet__reader-download--icon,\s*\.markdown-reader-action\.markdown-reader-download--icon\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center;/, 'icon-only download buttons should center their SVG glyph instead of using the text baseline');
    assert.match(combinedChatStyles, /@media \(max-width:\s*720px\)\s*\{[\s\S]*?\.delivery-card\s*\{[\s\S]*?width:\s*100%;/, 'mobile delivery cards should fit the chat column');
    assert.match(uiAsset.text, /imageAttachments\.length === 0 && fileAttachments\.length === 1/, 'single non-image delivery should bypass the extra group wrapper');
    assert.match(uiAsset.text, /function createDeliveryImagePreviewNode\(/, 'image deliveries should render dedicated preview tiles');
    assert.match(uiAsset.text, /openMessageImageViewer\(/, 'delivery image clicks should open the full-screen image viewer');
    assert.match(realtimeRenderAsset.text, /animate:\s*evt\?\.type === "attachment_delivery"/, 'delivery output should smoothly move the message viewport to the new result');
    assert.match(combinedChatStyles, /\.delivery-card-images\s*\{[\s\S]*?height:\s*calc\(var\(--artifact-row-height,\s*52px\) \* 2\)/, 'image delivery previews should reserve two artifact-row heights');
    assert.match(combinedChatStyles, /\.message-image-viewer\s*\{[\s\S]*?background:\s*rgba\(0,\s*0,\s*0,\s*0\.74\)/, 'full-screen image previews should use a translucent black scrim');
    assert.match(combinedChatStyles, /\.message-image-viewer__action\s*\{[\s\S]*?border-radius:\s*50%/, 'full-screen image controls should be circular');
    assert.match(combinedChatStyles, /@keyframes delivery-card-in[\s\S]*?opacity:\s*0[\s\S]*?transform:\s*translateY\(8px\)/, 'delivery cards should enter with a compositor-friendly fade and offset');
    assert.match(uiAsset.text, /artifact-group/, 'multi-file delivery should expose the shared artifact group semantics');
    assert.match(chatResponsiveStylesheet.text, /@media \(max-width:\s*767px\)\s*\{[\s\S]*?\.codex-plan-progress\s*\{[\s\S]*?display:\s*none !important;/, 'mobile progress summary cards should be hidden because Run Sheet and Live Bar already expose progress');

    const iconsAsset = await request(port, 'GET', '/chat/icons.js');
    assert.equal(iconsAsset.status, 200, 'icon asset should load');
    assert.match(iconsAsset.text, /"chevron-left":\s*'<path/, 'chevron icon should use the modern line-icon registry');
    assert.match(iconsAsset.text, /viewBox="0 0 24 24"/, 'icons should render from the shared 24px line grid');
    assert.match(iconsAsset.text, /fill="none" stroke="currentColor"/, 'icons should be outline glyphs, not filled legacy shapes');

    const markdownMathAsset = await request(port, 'GET', '/chat/markdown-math.js');
    assert.equal(markdownMathAsset.status, 200, 'Markdown math renderer asset should load');
    assert.match(markdownMathAsset.text, /function prepareMarkdownMath\(markdown\)/, 'Markdown math renderer should expose a source preprocessor');
    assert.match(markdownMathAsset.text, /function renderMarkdownMathInNode\(rootNode, tokens = \[\]\)/, 'Markdown math renderer should restore tokens into rendered Markdown');
    assert.match(markdownMathAsset.text, /MathML/, 'Markdown math renderer should use local MathML when KaTeX is not available');

    const runSheetAsset = await request(port, 'GET', '/chat/run-sheet.js');
    assert.equal(runSheetAsset.status, 200, 'Run Sheet asset should load');
    assert.match(runSheetAsset.text, /fetchRunSheetModel/, 'Run Sheet should own its lightweight data fetch');
    assert.match(runSheetAsset.text, /modelFromRunSheet/, 'Run Sheet should map only its dedicated projection fields');
    assert.doesNotMatch(page.text, /data-inspector-tab=/, 'retired audit tabs should not remain in the page');
    assert.doesNotMatch(chatStylesheet.text, /chat-workbench\.css/, 'the main stylesheet should not load retired audit CSS');

    const workspaceFileReaderAsset = await request(port, 'GET', '/chat/workspace-file-reader.js');
    assert.equal(workspaceFileReaderAsset.status, 200, 'workspace file reader asset should load');
    assert.match(workspaceFileReaderAsset.text, /function setReading\(reading\)/, 'workspace file reader should track reading mode separately from sidebar mount state');
    assert.match(workspaceFileReaderAsset.text, /workspace-file-reader--reading/, 'workspace file reader should toggle the reading-mode class');
    assert.match(workspaceFileReaderAsset.text, /dom\.backButton\?\.addEventListener\("click", showFileTree\)/, 'reader back chevron should return to the file tree instead of closing the sidebar');
    assert.match(workspaceFileReaderAsset.text, /ragent\.workspaceFileReaderListWidth/, 'workspace file reader should persist the file-list column width');
    assert.match(workspaceFileReaderAsset.text, /function handleListResizePointerDown\(event\)/, 'workspace file reader should support pointer-based file-list resizing');

    const rightSidebarAsset = await request(port, 'GET', '/chat/right-sidebar.js');
    assert.equal(rightSidebarAsset.status, 200, 'right sidebar asset should load');
    assert.match(rightSidebarAsset.text, /ragent\.rightSidebarWidth/, 'workspace sidebar should persist desktop resize width');
    assert.match(rightSidebarAsset.text, /function handleResizePointerDown\(event\)/, 'workspace sidebar should support pointer-based desktop resizing');
    assert.match(rightSidebarAsset.text, /SIDEBAR_CLOSE_ANIMATION_MS/, 'workspace sidebar should keep the panel mounted long enough for close animations');
    assert.match(rightSidebarAsset.text, /dom\.panel\.hidden = false/, 'workspace sidebar should unhide before applying the open class so entry animation can run');
    assert.match(rightSidebarAsset.text, /closeWorkbenchInspectorForSidebar/, 'workspace sidebar should close the session-scoped outcome inspector when opened');
    assert.match(rightSidebarAsset.text, /MOBILE_QUERY = "\(\max-width: 767px\)"/, 'workspace sidebar should track the mobile layout breakpoint');
    assert.match(rightSidebarAsset.text, /dom\.backButton\.hidden = !\(showingFiles \|\| showingOrganization \|\| isMobileSidebarLayout\(\)\)/, 'workspace sidebar should expose its back chevron on mobile home and subviews');
    assert.match(rightSidebarAsset.text, /function handleBackButtonClick\(\)/, 'workspace sidebar should route the back chevron by current view');
    assert.match(rightSidebarAsset.text, /root\.closeRightSidebar = close/, 'workspace sidebar should expose a close hook for the outcome inspector');

    const sessionSurfaceUiAsset = await request(port, 'GET', '/chat/session-surface-ui.js');
    assert.equal(sessionSurfaceUiAsset.status, 200, 'session surface ui asset should load');
    assert.match(sessionSurfaceUiAsset.text, /function createActiveSessionItem\(/);
    assert.match(sessionSurfaceUiAsset.text, /function getSessionListIndicatorInfo\(/);
    assert.match(sessionSurfaceUiAsset.text, /function getSessionListIndicatorInfo\([\s\S]*?session-item-status--needs-action/, 'waiting sessions should resolve to the amber needs-action indicator');
    assert.doesNotMatch(sessionSurfaceUiAsset.text, /function buildSessionMetaParts\(/);
    assert.doesNotMatch(sessionSurfaceUiAsset.text, /session-item-description/, 'session list items should not render a third description preview row');
    assert.match(sessionSurfaceUiAsset.text, /function getSessionStatusItemClass\(/);

    const sessionListUiAsset = await request(port, 'GET', '/chat/session-list-ui.js');
    assert.equal(sessionListUiAsset.status, 200, 'session list ui asset should load');
    assert.match(sessionListUiAsset.text, /function renderSessionList\(/);
    assert.match(sessionListUiAsset.text, /function attachSession\(/);
    assert.doesNotMatch(sessionListUiAsset.text, /session-item-meta/, 'archived session rows should not render metadata under the name');
    assert.match(sessionListUiAsset.text, /focusComposer\(\{ force: forceComposerFocus === true, preventScroll: true \}\)/);

    const sidebarUiAsset = await request(port, 'GET', '/chat/sidebar-ui.js');
    assert.equal(sidebarUiAsset.status, 200, 'sidebar ui asset should load');
    assert.match(sidebarUiAsset.text, /function openSidebar\(/);
    assert.match(sidebarUiAsset.text, /menuBtn\.addEventListener\("click", openSessionsSidebar\);/, 'header session button should always open the sessions tab');
    assert.match(sidebarUiAsset.text, /function createNewSessionShortcut\(/);
    assert.match(sidebarUiAsset.text, /function getProjectSummaryLabel\(/, 'workspace picker should derive a one-line collapsed label from the active project');
    assert.match(sidebarUiAsset.text, /t\("sidebar\.project\.summary", \{ name: project\.name \|\| t\("sidebar\.project\.untitled"\) \}\)/, 'workspace summary should prefix the selected project name through localization');
    assert.match(sidebarUiAsset.text, /workspaceSummaryButton\.addEventListener\("click"[\s\S]*?window\.ragentToggleProjectPicker\(\)/, 'workspace summary click should toggle the project picker');
    assert.match(sidebarUiAsset.text, /document\.addEventListener\("pointerdown", handleWorkspaceOutsidePointerDown, true\)/, 'workspace picker should collapse when clicking outside');
    assert.match(sidebarUiAsset.text, /document\.getElementById\(labelledBy\)[\s\S]*?picker\?\.contains\?\.?\(trigger\)/, 'workspace picker should treat all floating custom-select panels whose trigger lives inside the workspace controls as internal clicks');
    assert.match(sidebarUiAsset.text, /const nextExpanded = expanded === true/, 'workspace picker expanded state should remain view-only state');
    assert.doesNotMatch(sidebarUiAsset.text, /function stageWorkspaceMode\(/, 'workspace mode draft staging should be retired after the project-list migration');
    assert.doesNotMatch(sidebarUiAsset.text, /function stageCustomWorkspaceSelection\(/, 'custom folder draft staging should be retired after the project-list migration');
    assert.doesNotMatch(sidebarUiAsset.text, /function getWorkspaceBrowserCandidatePath\(/, 'workspace folder browser should be retired after the project-list migration');
    assert.doesNotMatch(sidebarUiAsset.text, /workspaceConfirm\.addEventListener\('click'/, 'workspace confirmation wiring should be retired after the project-list migration');
    assert.match(sidebarUiAsset.text, /requestLayoutPass\("composer-images"\)/);
    assert.match(sidebarUiAsset.text, /inputArea\?\.addEventListener\("drop"/, 'composer should handle desktop file drops through the attachment path');

    const settingsUiAsset = await request(port, 'GET', '/chat/settings-ui.js');
    assert.equal(settingsUiAsset.status, 200, 'settings ui asset should load');
    assert.match(settingsUiAsset.text, /function initUiLanguageSettings\(/);
    assert.match(settingsUiAsset.text, /function renderSettingsSessionPresentationPanel\(/);
    assert.match(settingsUiAsset.text, /function initInstallSettings\(/);
    assert.doesNotMatch(settingsUiAsset.text, /VoiceInput|voiceInput|settings\.voice/);

    const removedCcSwitchSettingsAsset = await request(port, 'GET', '/chat/cc-switch-settings.js');
    assert.equal(removedCcSwitchSettingsAsset.status, 404, 'retired cc-switch settings asset should not load');
    const removedProviderOnboardingAsset = await request(port, 'GET', '/chat/provider-onboarding.js');
    assert.equal(removedProviderOnboardingAsset.status, 404, 'retired provider onboarding asset should not load');

    const composeAsset = await request(port, 'GET', '/chat/compose.js');
    assert.equal(composeAsset.status, 200, 'compose asset should load');
    assert.match(composeAsset.text, /focusComposer\(\{ force: true, preventScroll: true \}\)/);
    assert.match(composeAsset.text, /function syncSidebarTabChrome\(/);
    assert.doesNotMatch(composeAsset.text, /document\.getElementById\("sidebarTitle"\)/);
    assert.match(composeAsset.text, /window\.RagentLayout\?\.subscribe/);
    assert.doesNotMatch(composeAsset.text, /voice-transcriptions/);

    const removedVoiceInputAsset = await request(port, 'GET', '/chat/voice-input.js');
    assert.equal(removedVoiceInputAsset.status, 404, 'removed voice input asset should not load');
    const removedVoiceWorkletAsset = await request(port, 'GET', '/chat/voice-input-worklet.js');
    assert.equal(removedVoiceWorkletAsset.status, 404, 'removed voice input worklet should not load');

    const initAssetReload = await request(port, 'GET', '/chat/init.js');
    assert.equal(initAssetReload.status, 200, 'init asset should load');
    assert.match(initAssetReload.text, /typeof getBootstrapAuthInfo === "function"/);
    assert.match(initAssetReload.text, /loadInlineTools\(\{ skipModelLoad: true \}\)/);
    assert.match(initAssetReload.text, /bootstrapViaHttp\(\{ deferOwnerRestore: true \}\)/);
    assert.match(initAssetReload.text, /intent !== "new-session"/, 'init should recognize the quick-entry launch intent');
    assert.match(initAssetReload.text, /forceComposerFocus: true/, 'launch intent should request a one-time forced composer focus');
    assert.match(page.text, /id="settingsInstallAppBtn"/, 'settings page should expose a direct install button');
    assert.doesNotMatch(page.text, /id="settingsInstallStatus"/, 'settings page should keep install status copy out of the compact layout');
    assert.match(page.text, /class="settings-group-card"/, 'settings page should use grouped setting cards');
    assert.match(page.text, /class="settings-row-select" id="uiThemeSelect"/, 'settings choices should render as compact setting-row controls');
    assert.doesNotMatch(page.text, /class="settings-section"[^>]*>\s*<div class="settings-section-title" data-i18n="settings\.theme\.title"/, 'settings page should not fall back to stacked form sections');
    assert.doesNotMatch(page.text, /data-i18n="settings\.(?:language|theme|thinkingBlocks|install|ccSwitch)\.note"/, 'compact settings rows should not render explanatory subcopy');
    assert.doesNotMatch(page.text, /class="voice-btn-meter"/, 'removed voice input controls should not render');

    // Static access-token login was retired by the 2026-08-05 security
    // hardening (password-only); no assertion here anymore.

    const splitAsset304 = await request(port, 'GET', '/chat/bootstrap.js', null, {
      'If-None-Match': splitAsset.headers.etag,
    });
    assert.equal(splitAsset304.status, 304, 'split asset should support conditional GETs');
    assert.equal(splitAsset304.text, '', '304 response should not include a body');

    const versionedSettingsUiAsset = await request(port, 'GET', '/chat/settings-ui.js?v=test-build');
    assert.equal(versionedSettingsUiAsset.status, 200, 'versioned settings ui asset should load');
    assert.equal(
      versionedSettingsUiAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned settings ui asset should be immutable cache hits',
    );

    const versionedSessionSurfaceUiAsset = await request(port, 'GET', '/chat/session-surface-ui.js?v=test-build');
    assert.equal(versionedSessionSurfaceUiAsset.status, 200, 'versioned session surface ui asset should load');
    assert.equal(
      versionedSessionSurfaceUiAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned session surface ui asset should be immutable cache hits',
    );

    const loader = await request(port, 'GET', '/chat.js');
    assert.equal(loader.status, 200, 'compatibility loader should still exist');
    assert.ok(loader.headers.etag, 'compatibility loader should expose an ETag');

    const loader304 = await request(port, 'GET', '/chat.js', null, {
      'If-None-Match': loader.headers.etag,
    });
    assert.equal(loader304.status, 304, 'loader should also support conditional GETs');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

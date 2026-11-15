#!/usr/bin/env node
// Stage 1 coverage for core/product-paths.js: direct unit expectations for the
// pure path math, plus a parity section that runs the legacy product-paths.js
// façade (DOM-less in Node, so it uses the FALLBACK_ORIGIN environment) against
// the injected-env core and asserts identical URL/path outputs.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function loadContext(relPath) {
  const context = { console, URL };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(repoRoot, relPath), 'utf8'), context, { filename: relPath });
  return context;
}

const coreContext = loadContext('static/chat/core/product-paths.js');
const core = coreContext.RagentProductPathsCore;
assert.ok(core, 'core/product-paths.js should attach RagentProductPathsCore');

const legacyContext = loadContext('static/chat/product-paths.js');
for (const verb of ['ragentGetProductBasePath', 'ragentGetProductBaseUrl', 'ragentResolveProductUrl', 'ragentResolveProductPath']) {
  assert.ok(typeof legacyContext[verb] === 'function', `product-paths.js should attach ${verb}`);
}
const legacyModule = {
  getProductBasePath: () => legacyContext.ragentGetProductBasePath(),
  getProductBaseUrl: () => legacyContext.ragentGetProductBaseUrl(),
  resolveProductUrl: (value) => legacyContext.ragentResolveProductUrl(value),
  resolveProductPath: (value) => legacyContext.ragentResolveProductPath(value),
};

// -- pure path math ----------------------------------------------------------
// splitPathSegments returns a sandbox-realm array; compare primitive-level.
assert.equal(core.splitPathSegments('/a/b/c').join(','), 'a,b,c');
assert.equal(core.splitPathSegments('  /a / /b  ').join(','), 'a,b');
assert.equal(core.splitPathSegments('').join(','), '');
assert.equal(core.splitPathSegments('///').join(','), '');
assert.equal(core.joinPathSegments(['a', 'b']), '/a/b');
assert.equal(core.joinPathSegments([]), '/');
assert.equal(core.joinPathSegments(null), '/');
assert.equal(core.inferProductBasePath(''), '/');
assert.equal(core.inferProductBasePath('/'), '/');
assert.equal(core.inferProductBasePath('/m/install'), '/');
assert.equal(core.inferProductBasePath('/a/m/install'), '/a');
assert.equal(core.inferProductBasePath('/login'), '/');
assert.equal(core.inferProductBasePath('/a/login'), '/a');
assert.equal(core.inferProductBasePath('/logout'), '/');
assert.equal(core.inferProductBasePath('/api/health'), '/');
assert.equal(core.inferProductBasePath('/a/api/b/c'), '/a');
assert.equal(core.inferProductBasePath('/ws'), '/');
assert.equal(core.inferProductBasePath('/share/abc'), '/');
assert.equal(core.inferProductBasePath('/share-asset/1'), '/');
assert.equal(core.inferProductBasePath('/visitor/2'), '/');
assert.equal(core.inferProductBasePath('/agent/3'), '/');
assert.equal(core.inferProductBasePath('/app/4'), '/');
assert.equal(core.inferProductBasePath('/a/app/4'), '/a');
assert.equal(core.inferProductBasePath('/deep/path/to/x'), '/deep/path/to/x');
assert.equal(core.inferProductBasePath('/a/m/install/login'), '/a/m/install');
assert.equal(core.ensureDirectoryPath('/'), '/');
assert.equal(core.ensureDirectoryPath('/m/install'), '/');
assert.equal(core.ensureDirectoryPath('/a'), '/a/');
assert.equal(core.ensureDirectoryPath('/a/'), '/a/');
assert.equal(core.isAbsoluteUrl('https://x.y/z'), true);
assert.equal(core.isAbsoluteUrl('mailto:a@b.c'), true);
assert.equal(core.isAbsoluteUrl('/x'), false);
assert.equal(core.isAbsoluteUrl('//x'), false);
assert.equal(core.isAlreadyScopedAbsolutePath('/x', '/'), true);
assert.equal(core.isAlreadyScopedAbsolutePath('/a/b', '/a'), true);
assert.equal(core.isAlreadyScopedAbsolutePath('/a', '/a'), true);
assert.equal(core.isAlreadyScopedAbsolutePath('/a?q=1', '/a'), true);
assert.equal(core.isAlreadyScopedAbsolutePath('/ab', '/a'), false);
assert.equal(core.isAlreadyScopedAbsolutePath('a', '/a'), false);

// -- env-injected resolution (browser-like env) ------------------------------
const browserEnv = {
  href: 'https://example.com/app/?tab=1',
  origin: 'https://example.com',
  baseHref: '',
};
assert.equal(core.getProductBasePath(browserEnv), '/');
assert.equal(core.getProductBaseUrl(browserEnv), 'https://example.com/');
assert.equal(core.resolveProductUrl('', browserEnv), 'https://example.com/');
assert.equal(core.resolveProductUrl('/m/install', browserEnv), 'https://example.com/m/install');
assert.equal(core.resolveProductUrl('/api/x', browserEnv), 'https://example.com/api/x');
assert.equal(core.resolveProductUrl('/app/tools', browserEnv), 'https://example.com/app/tools');
assert.equal(core.resolveProductUrl('tools', browserEnv), 'https://example.com/tools');
assert.equal(core.resolveProductUrl('?q=2', browserEnv), 'https://example.com/?q=2');
assert.equal(core.resolveProductUrl('#frag', browserEnv), 'https://example.com/#frag');
assert.equal(core.resolveProductUrl('//cdn.example/a.png', browserEnv), 'https://cdn.example/a.png');
assert.equal(core.resolveProductUrl('https://abs.example/x', browserEnv), 'https://abs.example/x');
assert.equal(core.resolveProductPath('', browserEnv), '/');
assert.equal(core.resolveProductPath('/api/x', browserEnv), '/api/x');
assert.equal(core.resolveProductPath('?q=2', browserEnv), '/?q=2');
assert.equal(core.resolveProductPath('#frag', browserEnv), '/#frag');

// baseHref override (no legacy counterpart — legacy needs a DOM document).
assert.equal(core.getProductBasePath({ href: 'https://example.com/x/', origin: 'https://example.com', baseHref: '/base/m/install' }), '/base');
assert.equal(core.resolveProductUrl('/foo', { href: 'https://example.com/x/', origin: 'https://example.com', baseHref: '/base/m/install' }), 'https://example.com/base/foo');

// -- parity vs legacy (DOM-less → FALLBACK_ORIGIN environment) ---------------
const fallbackEnv = { href: 'https://agentoc.invalid/', origin: 'https://agentoc.invalid', baseHref: '' };
const battery = [
  '', '/', '/m/install', '/login', '/logout', '/api/health', '/ws', '/share/abc?x=1',
  '/share-asset/1', '/visitor/2', '/agent/3', '/app/4', '/deep/path/to/x', '/a/m/install',
  '/a/api/b', '/x/m/install/login', '?tab=1', '#frag', '/?q=1', '//cdn.example.com/x.png',
  'https://abs.example/a', 'mailto:x@y.z', 'm/install', 'install', 'relative/path', '../up',
  '0', '  /spaced/  ',
];
for (const value of battery) {
  assert.equal(core.resolveProductUrl(value, fallbackEnv), legacyModule.resolveProductUrl(value), `parity url ${JSON.stringify(value)}`);
  assert.equal(core.resolveProductPath(value, fallbackEnv), legacyModule.resolveProductPath(value), `parity path ${JSON.stringify(value)}`);
}
assert.equal(core.getProductBasePath(fallbackEnv), legacyModule.getProductBasePath(), 'parity base path');
assert.equal(core.getProductBaseUrl(fallbackEnv), legacyModule.getProductBaseUrl(), 'parity base url');

// -- session sidebar / workspace-filtered list URLs (Stage 2 increments) -----
// Direct units: sidebar URL is pure; the workspace URL takes env selector
// functions mirroring the legacy window.ragentGet* hooks.
assert.equal(core.getSessionSidebarUrl('s1'), '/api/sessions/s1?view=sidebar');
assert.equal(core.getSessionSidebarUrl('a b/c'), '/api/sessions/a%20b%2Fc?view=sidebar');
assert.equal(core.getWorkspaceFilteredSessionListUrl('/api/sessions'), '/api/sessions');
assert.equal(
  core.getWorkspaceFilteredSessionListUrl('/api/sessions', { getSelectedProjectId: () => ' p1 ' }),
  '/api/sessions?projectId=p1',
);
assert.equal(
  core.getWorkspaceFilteredSessionListUrl('/api/sessions?q=1', { getSelectedProjectId: () => 'p1' }),
  '/api/sessions?q=1&projectId=p1',
);
assert.equal(
  core.getWorkspaceFilteredSessionListUrl('/api/sessions', { getSelectedProjectId: () => '' }),
  '/api/sessions',
);
assert.equal(
  core.getWorkspaceFilteredSessionListUrl('/api/sessions/archived', { getSelectedSessionFolder: () => ' f1 ' }),
  '/api/sessions/archived?folder=f1',
);
assert.equal(
  core.getWorkspaceFilteredSessionListUrl('/api/sessions', { getDefaultSessionFolder: () => 'f1' }),
  '/api/sessions?folder=f1',
);
assert.equal(
  core.getWorkspaceFilteredSessionListUrl('/api/sessions', { getSelectedSessionFolder: () => '' }),
  '/api/sessions',
);
// Project wins over folder when both are present.
assert.equal(
  core.getWorkspaceFilteredSessionListUrl('/api/sessions', {
    getSelectedProjectId: () => 'p1',
    getSelectedSessionFolder: () => 'f1',
  }),
  '/api/sessions?projectId=p1',
);

// Parity: the legacy functions live in session-http-helpers.js (sidebar URL)
// and session-http.js (workspace URL, reading window.ragentGet* hooks).
function loadLegacyUrls() {
  const context = {
    console,
    Promise,
    Map,
    Set,
    Date,
    Error,
    URL,
    URLSearchParams,
    encodeURIComponent,
    navigator: {},
    window: { addEventListener() {} },
  };
  vm.runInNewContext(
    `const renderedEventState = {
      sessionId: null, earliestSeq: 0, latestSeq: 0, eventCount: 0, eventBaseKeys: [],
      eventKeys: [], runState: "idle", runActivity: null, operationNodesById: new Map(),
      operationSnapshotsById: new Map(), expandedOperationIds: new Set(),
      runningBlockExpanded: false, hasMoreBefore: false, loadingOlder: false,
    };
    let currentSessionId = "";
    const emptyState = { parentNode: null };
    const messagesInner = {};
    emptyState.parentNode = messagesInner;
    const messagesEl = { addEventListener() {} };`,
    context,
  );
  vm.runInNewContext(readFileSync(join(repoRoot, 'static/chat/session-http-helpers.js'), 'utf8'), context, { filename: 'session-http-helpers.js' });
  vm.runInNewContext(readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8'), context, { filename: 'session-http.js' });
  let projectId = '';
  let selectedFolder = '';
  let defaultFolder = '';
  context.window.ragentGetSelectedProjectId = () => projectId;
  context.window.ragentGetSelectedSessionFolder = () => selectedFolder;
  context.window.ragentGetDefaultSessionFolder = () => defaultFolder;
  return {
    getSessionSidebarUrl: (id) => context.getSessionSidebarUrl(id),
    getWorkspaceFilteredSessionListUrl: (url) => context.getWorkspaceFilteredSessionListUrl(url),
    setAmbient(patch) {
      if ('projectId' in patch) projectId = patch.projectId;
      if ('selectedFolder' in patch) selectedFolder = patch.selectedFolder;
      if ('defaultFolder' in patch) defaultFolder = patch.defaultFolder;
    },
  };
}
const legacyUrls = loadLegacyUrls();

for (const id of ['s1', 'a b/c', '', 's%20x', null, undefined]) {
  assert.equal(core.getSessionSidebarUrl(id), legacyUrls.getSessionSidebarUrl(id), `parity sidebar url ${JSON.stringify(id)}`);
}
const workspaceBattery = [
  ['/api/sessions', {}],
  ['/api/sessions/archived', {}],
  ['/api/sessions?q=1', {}],
  ['/api/sessions', { projectId: 'p1' }],
  ['/api/sessions', { projectId: ' p1 ' }],
  ['/api/sessions?q=1', { projectId: 'p 1' }],
  ['/api/sessions', { projectId: '', selectedFolder: 'f1' }],
  ['/api/sessions/archived', { selectedFolder: ' f 1 ' }],
  ['/api/sessions', { selectedFolder: '', defaultFolder: 'd1' }],
  ['/api/sessions', { defaultFolder: 'd1' }],
  ['/api/sessions', { projectId: '', selectedFolder: '', defaultFolder: '' }],
  ['/api/sessions', { projectId: 'p1', selectedFolder: 'f1', defaultFolder: 'd1' }],
  ['/api/sessions?tab=2#frag', { projectId: 'p1' }],
];
for (const [baseUrl, ambient] of workspaceBattery) {
  legacyUrls.setAmbient(ambient);
  // The legacy window hooks always exist (empty-string defaults), so the core
  // env must inject all three selectors unconditionally — the default-folder
  // fallback branch (selected hook absent) is covered by the direct units.
  const env = {
    getSelectedProjectId: () => ambient.projectId ?? '',
    getSelectedSessionFolder: () => ambient.selectedFolder ?? '',
    getDefaultSessionFolder: () => ambient.defaultFolder ?? '',
  };
  assert.equal(
    core.getWorkspaceFilteredSessionListUrl(baseUrl, env),
    legacyUrls.getWorkspaceFilteredSessionListUrl(baseUrl),
    `parity workspace url ${JSON.stringify(baseUrl)} ${JSON.stringify(ambient)}`,
  );
}

console.log('test-chat-product-paths-core: ok');

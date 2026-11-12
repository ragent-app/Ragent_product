#!/usr/bin/env node
// GitHub App connector tests. Uses a throwaway AGENTOC_CONFIG_DIR so the
// 0600 config/token files never touch the real instance, and a mock fetch
// for the OAuth exchange and API calls — no real GitHub requests.
import assert from 'assert/strict';
import { mkdtempSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempConfigDir = mkdtempSync(join(tmpdir(), 'agentoc-github-test-'));
process.env.AGENTOC_CONFIG_DIR = tempConfigDir;

const {
  buildGitHubAuthorizeUrl,
  createGitHubIssue,
  createGitHubIssueComment,
  getGitHubActionsStatus,
  getGitHubConnectorStatus,
  GITHUB_APP_CONFIG_PATH,
  GITHUB_AUTH_STATE_PATH,
  GITHUB_USER_TOKENS_FILE,
  handleGitHubAuthCallback,
  listGitHubIssues,
  listGitHubPulls,
  listGitHubRepos,
  loadActiveGitHubUserToken,
  loadGitHubAppConfig,
  resolveGitHubCallbackUrl,
  saveGitHubAppConfig,
  summarizeGitHubAppConfig,
} = await import('../lib/connector-github.mjs');
const { listConnectorBindings } = await import('../lib/connector-bindings.mjs');
const { readJson, writeJsonAtomic } = await import('../chat/fs-utils.mjs');

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function mockFetch(routes) {
  return async (url, options = {}) => {
    const target = String(url);
    for (const [match, handler] of routes) {
      if ((typeof match === 'string' && target === match) || (match instanceof RegExp && match.test(target))) {
        return handler(target, options);
      }
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
}

// --- callback URL resolution ---
assert.equal(
  resolveGitHubCallbackUrl('https://agentoc.andyscodexagent.cyou'),
  'https://agentoc.andyscodexagent.cyou/api/connectors/github/callback',
);
assert.equal(
  resolveGitHubCallbackUrl('https://ragent.agentoncloud.com/'),
  'https://ragent.agentoncloud.com/api/connectors/github/callback',
);
assert.equal(resolveGitHubCallbackUrl(''), '');

// --- config storage + redaction ---
const initialStatus = await getGitHubConnectorStatus({ redirectUri: resolveGitHubCallbackUrl('https://x.example') });
assert.equal(initialStatus.configured, false);
assert.equal(initialStatus.clientSecretPresent, false);
assert.equal(initialStatus.binding, null);

await saveGitHubAppConfig({
  clientSecret: 'super-secret-value',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
});
const config = await loadGitHubAppConfig();
assert.equal(config.appId, '4516890');
assert.equal(config.clientId, 'Iv23liYGXXeJlos97OHi');
const configMode = statSync(join(tempConfigDir, 'github-connector', 'github-app-config.json')).mode & 0o777;
assert.equal(configMode, 0o600, 'config file must be 0600');

const summary = summarizeGitHubAppConfig(config);
assert.equal(summary.configured, true);
assert.equal(summary.clientSecretPresent, true);
assert.equal(summary.privateKeyPresent, true);
assert.equal(JSON.stringify(summary).includes('super-secret-value'), false);
assert.equal(JSON.stringify(summary).includes('BEGIN RSA PRIVATE KEY'), false);

// Save without the secret keeps the existing one.
await saveGitHubAppConfig({ appId: '9999999' });
const updated = await loadGitHubAppConfig();
assert.equal(updated.appId, '9999999');
assert.equal(updated.clientSecret, 'super-secret-value');

// --- authorize URL: a clientId-only config (no secret) must refuse ---
await writeJsonAtomic(GITHUB_APP_CONFIG_PATH, {
  appId: '4516890',
  clientId: 'Iv23liYGXXeJlos97OHi',
});
await assert.rejects(
  buildGitHubAuthorizeUrl({ baseUrl: 'https://x.example' }),
  /client secret is not configured/,
);
await saveGitHubAppConfig({
  clientSecret: 'super-secret-value',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
});

const authorizeUrl = await buildGitHubAuthorizeUrl({ baseUrl: 'https://ragent.agentoncloud.com' });
assert.ok(authorizeUrl.startsWith('https://github.com/login/oauth/authorize?'));
assert.ok(authorizeUrl.includes(`client_id=${encodeURIComponent('Iv23liYGXXeJlos97OHi')}`));
assert.ok(authorizeUrl.includes(`redirect_uri=${encodeURIComponent('https://ragent.agentoncloud.com/api/connectors/github/callback')}`));
const stateParam = new URL(authorizeUrl).searchParams.get('state');
assert.ok(stateParam && stateParam.length >= 16);
const storedState = await readJson(GITHUB_AUTH_STATE_PATH, null);
assert.equal(storedState.state, stateParam);

// --- callback: state mismatch is rejected ---
await assert.rejects(
  handleGitHubAuthCallback({ code: 'code-1', state: 'wrong-state', baseUrl: 'https://x.example' }),
  /invalid or expired/,
);

// --- callback: happy path (mock exchange + user + installations) ---
const fetchImpl = mockFetch([
  [
    'https://github.com/login/oauth/access_token',
    async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.client_id, 'Iv23liYGXXeJlos97OHi');
      assert.equal(body.client_secret, 'super-secret-value');
      assert.equal(body.code, 'code-1');
      assert.ok(body.redirect_uri.endsWith('/api/connectors/github/callback'));
      return jsonResponse({
        access_token: 'user-token-1',
        token_type: 'bearer',
        expires_in: 28800,
        refresh_token: 'refresh-1',
      });
    },
  ],
  [
    'https://api.github.com/user',
    () => jsonResponse({ id: 123, login: 'octo' }),
  ],
  [
    'https://api.github.com/user/installations',
    () => jsonResponse({ installations: [{ id: 456, account: { login: 'octo' } }] }),
  ],
]);

const result = await handleGitHubAuthCallback({
  code: 'code-1',
  state: stateParam,
  baseUrl: 'https://ragent.agentoncloud.com',
  fetchImpl,
});
assert.deepEqual(result, { user: { id: '123', login: 'octo' }, installationId: '456' });

const tokens = await readJson(GITHUB_USER_TOKENS_FILE, {});
assert.equal(tokens['123'].accessToken, 'user-token-1');
assert.equal(tokens['123'].login, 'octo');
assert.equal(tokens['123'].installationId, '456');
const tokenMode = statSync(GITHUB_USER_TOKENS_FILE).mode & 0o777;
assert.equal(tokenMode, 0o600, 'token file must be 0600');

const bindings = await listConnectorBindings({ includeCompatibilityEmail: false });
const githubBinding = bindings.find((binding) => binding.connectorId === 'github');
assert.ok(githubBinding, 'github binding must exist after callback');
assert.equal(githubBinding.accountHint, 'octo');
assert.equal(githubBinding.installationId, '456');
assert.equal(githubBinding.capabilityState, 'ready');

const connectedStatus = await getGitHubConnectorStatus({
  binding: githubBinding,
  redirectUri: resolveGitHubCallbackUrl('https://x.example'),
});
assert.equal(connectedStatus.binding.capabilityState, 'ready');
assert.equal(connectedStatus.binding.accountHint, 'octo');

const active = await loadActiveGitHubUserToken();
assert.equal(active.userId, '123');
assert.equal(active.accessToken, 'user-token-1');

// --- repo/issue/pull/actions API with a mock GitHub API ---
const apiFetchImpl = mockFetch([
  [
    /^https:\/\/api\.github\.com\/user\/repos/,
    () => jsonResponse([
      {
        full_name: 'octo/repo-a', name: 'repo-a', owner: { login: 'octo' },
        private: false, default_branch: 'main', updated_at: '2026-08-01T00:00:00Z',
      },
    ]),
  ],
  [
    /^https:\/\/api\.github\.com\/repos\/octo\/repo-a\/issues\?state=open/,
    () => jsonResponse([
      {
        number: 7, title: 'Hello issue', state: 'open', user: { login: 'octo' },
        comments: 2, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-02T00:00:00Z',
        html_url: 'https://github.com/octo/repo-a/issues/7',
      },
    ]),
  ],
  [
    /^https:\/\/api\.github\.com\/repos\/octo\/repo-a\/pulls\?state=open/,
    () => jsonResponse([
      {
        number: 9, title: 'PR title', state: 'open', user: { login: 'octo' },
        head: { ref: 'feature' }, base: { ref: 'main' },
        created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-02T00:00:00Z',
        html_url: 'https://github.com/octo/repo-a/pull/9',
      },
    ]),
  ],
  [
    /^https:\/\/api\.github\.com\/repos\/octo\/repo-a\/actions\/runs/,
    () => jsonResponse({
      workflow_runs: [
        {
          id: 100, name: 'CI', display_title: 'fix ci', status: 'completed',
          conclusion: 'success', head_branch: 'main', event: 'push',
          created_at: '2026-08-01T00:00:00Z', html_url: 'https://github.com/octo/repo-a/actions/runs/100',
        },
      ],
    }),
  ],
]);

const repos = await listGitHubRepos({ fetchImpl: apiFetchImpl });
assert.deepEqual(repos, [
  {
    fullName: 'octo/repo-a', name: 'repo-a', owner: 'octo',
    private: false, defaultBranch: 'main', updatedAt: '2026-08-01T00:00:00Z',
  },
]);

const issues = await listGitHubIssues('octo', 'repo-a', { state: 'open', fetchImpl: apiFetchImpl });
assert.equal(issues.length, 1);
assert.equal(issues[0].number, 7);
assert.equal(issues[0].title, 'Hello issue');

const pulls = await listGitHubPulls('octo', 'repo-a', { state: 'open', fetchImpl: apiFetchImpl });
assert.equal(pulls.length, 1);
assert.equal(pulls[0].headRef, 'feature');
assert.equal(pulls[0].baseRef, 'main');

const runs = await getGitHubActionsStatus('octo', 'repo-a', { fetchImpl: apiFetchImpl });
assert.equal(runs.length, 1);
assert.equal(runs[0].name, 'CI');
assert.equal(runs[0].conclusion, 'success');

// --- write-call input validation ---
await assert.rejects(
  createGitHubIssue('octo', 'repo-a', { title: '' }, { fetchImpl: apiFetchImpl }),
  /Issue title is required/,
);
await assert.rejects(
  createGitHubIssueComment('octo', 'repo-a', 0, 'body', { fetchImpl: apiFetchImpl }),
  /positive integer/,
);
await assert.rejects(
  createGitHubIssueComment('octo', 'repo-a', 3, '', { fetchImpl: apiFetchImpl }),
  /Comment body is required/,
);

console.log('test-connector-github: ok');

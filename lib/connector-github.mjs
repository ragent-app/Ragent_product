// GitHub App connector (first phase).
//
// Flow: the owner configures the GitHub App (appId/clientId are public and
// pre-filled; clientSecret and the private key stay server-side in a 0600
// file), then POSTs /api/connectors/github/authorize to get a GitHub OAuth
// URL. Because the App was created with "request user authorization during
// installation", the user is prompted to install and authorize in one step.
// The callback exchanges the code for a user access token, resolves the
// GitHub user + installation, and stores the token per GitHub user id in a
// 0600 file. Repository/Issue/PR/Actions calls then run with the user access
// token (user-to-server) — the private key is stored for later phases
// (installation tokens / webhook signing) and is not needed for phase one.
//
// The frontend/status API never sees the clientSecret or private key — only
// booleans indicating presence. Everything is owner-scoped for now (the
// instance is single-owner); the per-user token map keeps the storage shape
// ready for future multi-owner use.

import { randomUUID } from 'crypto';
import { access } from 'fs/promises';
import { join } from 'path';

import { readJson, writeJsonAtomic } from '../chat/fs-utils.mjs';
import { CONFIG_DIR } from './config.mjs';
import { ensureGitHubConnectorBinding } from './connector-bindings.mjs';

export const GITHUB_CONNECTOR_DIR = join(CONFIG_DIR, 'github-connector');
export const GITHUB_APP_CONFIG_PATH = join(GITHUB_CONNECTOR_DIR, 'github-app-config.json');
export const GITHUB_AUTH_STATE_PATH = join(GITHUB_CONNECTOR_DIR, 'github-auth-state.json');
export const GITHUB_USER_TOKENS_FILE = join(GITHUB_CONNECTOR_DIR, 'github-user-tokens.json');
export const GITHUB_BINDING_ID = 'binding_github_owner';

// appId and clientId are public identifiers of the GitHub App — safe to
// pre-fill. clientSecret and privateKey are secrets and are only ever
// written to the 0600 config file, never returned by the status API.
export const DEFAULT_GITHUB_APP_ID = '4516890';
export const DEFAULT_GITHUB_CLIENT_ID = 'Iv23liYGXXeJlos97OHi';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_BASE = 'https://api.github.com';
const SECRET_FILE_MODE = 0o600;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso() {
  return new Date().toISOString();
}

async function pathExists(pathname) {
  if (!pathname) return false;
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

export function resolveGitHubCallbackUrl(baseUrl, providedRedirectUri = '') {
  const base = trimString(baseUrl) || trimString(providedRedirectUri);
  if (!base) return '';
  return `${base.replace(/\/+$/, '')}/api/connectors/github/callback`;
}

export async function loadGitHubAppConfig() {
  return await readJson(GITHUB_APP_CONFIG_PATH, null);
}

export async function saveGitHubAppConfig({ appId, clientId, clientSecret, privateKey } = {}) {
  const existing = (await loadGitHubAppConfig()) || {};
  const next = {
    appId: trimString(appId) || trimString(existing.appId) || DEFAULT_GITHUB_APP_ID,
    clientId: trimString(clientId) || trimString(existing.clientId) || DEFAULT_GITHUB_CLIENT_ID,
    ...(Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'clientSecret')
      ? { clientSecret: trimString(clientSecret) }
      : (existing.clientSecret ? { clientSecret: existing.clientSecret } : {})),
    ...(Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'privateKey')
      ? { privateKey: trimString(privateKey) }
      : (existing.privateKey ? { privateKey: existing.privateKey } : {})),
    updatedAt: nowIso(),
  };
  await writeJsonAtomic(GITHUB_APP_CONFIG_PATH, next, { mode: SECRET_FILE_MODE });
  return next;
}

// Public, safe-to-expose configuration summary. Never includes the client
// secret or the private key payload.
export function summarizeGitHubAppConfig(config) {
  return {
    configured: !!config?.clientId,
    appId: trimString(config?.appId),
    clientId: trimString(config?.clientId),
    clientSecretPresent: !!trimString(config?.clientSecret),
    privateKeyPresent: !!trimString(config?.privateKey),
  };
}

export async function getGitHubConnectorStatus({ binding, redirectUri } = {}) {
  const config = await loadGitHubAppConfig();
  const summary = summarizeGitHubAppConfig(config);
  return {
    ...summary,
    redirectUri: trimString(redirectUri),
    binding: binding?.connectorId === 'github'
      ? {
          id: trimString(binding.id),
          title: trimString(binding.title),
          provider: trimString(binding.provider),
          accountHint: trimString(binding.accountHint),
          installationId: trimString(binding.installationId),
          githubUserId: trimString(binding.githubUserId),
          capabilityState: trimString(binding.capabilityState),
        }
      : null,
  };
}

// Start the OAuth flow: persist a random state (bound to the callback
// redirect URI) and hand back the GitHub authorization URL. The callback URI
// must be registered with the GitHub App for the configured public base URL.
export async function buildGitHubAuthorizeUrl({ baseUrl, redirectUri, state = '' } = {}) {
  const config = await loadGitHubAppConfig();
  const clientId = trimString(config?.clientId);
  if (!clientId) {
    throw new Error('GitHub App is not configured yet.');
  }
  if (!trimString(config?.clientSecret)) {
    throw new Error('GitHub App client secret is not configured yet.');
  }
  const effectiveRedirectUri = resolveGitHubCallbackUrl(baseUrl, redirectUri);
  if (!effectiveRedirectUri) {
    throw new Error('Cannot determine the GitHub callback URL.');
  }
  const nextState = trimString(state) || randomUUID();
  await writeJsonAtomic(GITHUB_AUTH_STATE_PATH, {
    state: nextState,
    redirectUri: effectiveRedirectUri,
    createdAt: nowIso(),
  });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: effectiveRedirectUri,
    state: nextState,
  });
  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCodeForUserAccessToken({ config, code, redirectUri, fetchImpl }) {
  const response = await fetchImpl(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: trimString(config.clientId),
      client_secret: trimString(config.clientSecret),
      code: trimString(code),
      redirect_uri: trimString(redirectUri),
    }),
  });
  const data = await response.json().catch(() => null);
  const errorDescription = trimString(data?.error_description);
  if (!data?.access_token) {
    throw new Error(errorDescription || `GitHub token exchange failed (HTTP ${response.status}).`);
  }
  return data;
}

async function githubApiFetch(pathname, { token, method = 'GET', body = null, fetchImpl } = {}) {
  const headers = {
    Authorization: `Bearer ${trimString(token)}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body !== null) headers['Content-Type'] = 'application/json';
  const response = await fetchImpl(`${GITHUB_API_BASE}${pathname}`, {
    method,
    headers,
    ...(body !== null ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = trimString(data?.message)
      || trimString(data?.error_description)
      || `GitHub API error (HTTP ${response.status}).`;
    throw new Error(message);
  }
  return data;
}

export async function loadActiveGitHubUserToken() {
  const tokens = await readJson(GITHUB_USER_TOKENS_FILE, {});
  const entries = Object.entries(tokens || {}).filter(([, entry]) => entry && trimString(entry.accessToken));
  if (!entries.length) return null;
  entries.sort((left, right) => String(right[1].updatedAt || '').localeCompare(String(left[1].updatedAt || '')));
  const [userId, entry] = entries[0];
  return {
    userId: trimString(userId),
    login: trimString(entry.login),
    installationId: trimString(entry.installationId),
    accessToken: trimString(entry.accessToken),
  };
}

// Complete the OAuth callback: validate state, exchange the code for a user
// access token, resolve the GitHub user and their first installation, and
// persist both the token map entry and the connector binding.
export async function handleGitHubAuthCallback({ code, state, baseUrl, redirectUri, fetchImpl = fetch } = {}) {
  const authState = await readJson(GITHUB_AUTH_STATE_PATH, null);
  const validState = trimString(state)
    && authState
    && trimString(authState.state) === trimString(state);
  if (!trimString(code) || !validState) {
    throw new Error('GitHub authorization callback is invalid or expired.');
  }

  const config = await loadGitHubAppConfig();
  if (!config?.clientId || !config?.clientSecret) {
    throw new Error('GitHub App is not configured yet.');
  }
  const effectiveRedirectUri = resolveGitHubCallbackUrl(baseUrl, redirectUri)
    || trimString(authState.redirectUri);
  if (!effectiveRedirectUri) {
    throw new Error('Cannot determine the GitHub callback URL.');
  }

  const tokenData = await exchangeCodeForUserAccessToken({
    config,
    code,
    redirectUri: effectiveRedirectUri,
    fetchImpl,
  });

  const [user, installations] = await Promise.all([
    githubApiFetch('/user', { token: tokenData.access_token, fetchImpl }),
    githubApiFetch('/user/installations', { token: tokenData.access_token, fetchImpl }),
  ]);
  const installation = Array.isArray(installations?.installations) && installations.installations.length
    ? installations.installations[0]
    : null;
  const userId = trimString(String(user?.id ?? ''));
  const login = trimString(user?.login);
  if (!userId || !login) {
    throw new Error('GitHub authorization did not return a user.');
  }

  const tokens = (await readJson(GITHUB_USER_TOKENS_FILE, {})) || {};
  tokens[userId] = {
    login,
    installationId: installation ? trimString(String(installation.id)) : '',
    accessToken: trimString(tokenData.access_token),
    refreshToken: trimString(tokenData.refresh_token),
    tokenType: trimString(tokenData.token_type),
    expiresIn: Number.isFinite(Number(tokenData.expires_in)) ? Number(tokenData.expires_in) : null,
    scope: trimString(tokenData.scope),
    updatedAt: nowIso(),
  };
  await writeJsonAtomic(GITHUB_USER_TOKENS_FILE, tokens, { mode: SECRET_FILE_MODE });

  await ensureGitHubConnectorBinding({
    bindingId: GITHUB_BINDING_ID,
    provider: 'github',
    accountHint: login,
    tokenPath: GITHUB_USER_TOKENS_FILE,
    githubUserId: userId,
    installationId: installation ? trimString(String(installation.id)) : '',
    title: login,
  });

  return {
    user: { id: userId, login },
    installationId: installation ? trimString(String(installation.id)) : '',
  };
}

async function requireUserToken(fetchImpl) {
  const active = await loadActiveGitHubUserToken();
  if (!active?.accessToken) {
    throw new Error('GitHub is not connected. Connect the GitHub App first.');
  }
  if (fetchImpl && typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function.');
  }
  return { ...active, fetchImpl: fetchImpl || fetch };
}

export async function listGitHubRepos({ fetchImpl } = {}) {
  const { accessToken, fetchImpl: doFetch } = await requireUserToken(fetchImpl);
  const data = await githubApiFetch('/user/repos?per_page=100&sort=updated', {
    token: accessToken,
    fetchImpl: doFetch,
  });
  return Array.isArray(data)
    ? data.map((repo) => ({
        fullName: trimString(repo.full_name),
        name: trimString(repo.name),
        owner: trimString(repo.owner?.login),
        private: repo.private === true,
        defaultBranch: trimString(repo.default_branch),
        updatedAt: trimString(repo.updated_at),
      }))
    : [];
}

export async function listGitHubIssues(owner, repo, { state = 'open', fetchImpl } = {}) {
  const { accessToken, fetchImpl: doFetch } = await requireUserToken(fetchImpl);
  const data = await githubApiFetch(
    `/repos/${encodeURIComponent(trimString(owner))}/${encodeURIComponent(trimString(repo))}/issues`
    + `?state=${encodeURIComponent(trimString(state) || 'open')}&per_page=100`,
    { token: accessToken, fetchImpl: doFetch },
  );
  return Array.isArray(data)
    ? data.map((issue) => ({
        number: issue.number,
        title: trimString(issue.title),
        state: trimString(issue.state),
        user: trimString(issue.user?.login),
        comments: Number.isFinite(Number(issue.comments)) ? Number(issue.comments) : 0,
        createdAt: trimString(issue.created_at),
        updatedAt: trimString(issue.updated_at),
        htmlUrl: trimString(issue.html_url),
      }))
    : [];
}

export async function createGitHubIssue(owner, repo, { title = '', body = '' } = {}, { fetchImpl } = {}) {
  const trimmedTitle = trimString(title);
  if (!trimmedTitle) {
    throw new Error('Issue title is required.');
  }
  const { accessToken, fetchImpl: doFetch } = await requireUserToken(fetchImpl);
  return await githubApiFetch(
    `/repos/${encodeURIComponent(trimString(owner))}/${encodeURIComponent(trimString(repo))}/issues`,
    {
      method: 'POST',
      token: accessToken,
      body: { title: trimmedTitle, ...(trimString(body) ? { body: trimString(body) } : {}) },
      fetchImpl: doFetch,
    },
  );
}

export async function listGitHubPulls(owner, repo, { state = 'open', fetchImpl } = {}) {
  const { accessToken, fetchImpl: doFetch } = await requireUserToken(fetchImpl);
  const data = await githubApiFetch(
    `/repos/${encodeURIComponent(trimString(owner))}/${encodeURIComponent(trimString(repo))}/pulls`
    + `?state=${encodeURIComponent(trimString(state) || 'open')}&per_page=100`,
    { token: accessToken, fetchImpl: doFetch },
  );
  return Array.isArray(data)
    ? data.map((pull) => ({
        number: pull.number,
        title: trimString(pull.title),
        state: trimString(pull.state),
        user: trimString(pull.user?.login),
        headRef: trimString(pull.head?.ref),
        baseRef: trimString(pull.base?.ref),
        createdAt: trimString(pull.created_at),
        updatedAt: trimString(pull.updated_at),
        htmlUrl: trimString(pull.html_url),
      }))
    : [];
}

export async function createGitHubIssueComment(owner, repo, issueNumber, body = '', { fetchImpl } = {}) {
  const trimmedBody = trimString(body);
  if (!trimmedBody) {
    throw new Error('Comment body is required.');
  }
  const number = Number(issueNumber);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error('Issue number must be a positive integer.');
  }
  const { accessToken, fetchImpl: doFetch } = await requireUserToken(fetchImpl);
  return await githubApiFetch(
    `/repos/${encodeURIComponent(trimString(owner))}/${encodeURIComponent(trimString(repo))}`
    + `/issues/${number}/comments`,
    {
      method: 'POST',
      token: accessToken,
      body: { body: trimmedBody },
      fetchImpl: doFetch,
    },
  );
}

export async function getGitHubActionsStatus(owner, repo, { perPage = 10, fetchImpl } = {}) {
  const { accessToken, fetchImpl: doFetch } = await requireUserToken(fetchImpl);
  const data = await githubApiFetch(
    `/repos/${encodeURIComponent(trimString(owner))}/${encodeURIComponent(trimString(repo))}/actions/runs`
    + `?per_page=${Number.isFinite(Number(perPage)) ? Math.min(Math.max(1, Number(perPage)), 50) : 10}`,
    { token: accessToken, fetchImpl: doFetch },
  );
  return Array.isArray(data?.workflow_runs)
    ? data.workflow_runs.map((run) => ({
        id: run.id,
        name: trimString(run.name),
        displayTitle: trimString(run.display_title),
        status: trimString(run.status),
        conclusion: trimString(run.conclusion),
        headBranch: trimString(run.head_branch),
        event: trimString(run.event),
        createdAt: trimString(run.created_at),
        htmlUrl: trimString(run.html_url),
      }))
    : [];
}

export async function disconnectGitHub({ binding } = {}) {
  if (binding?.connectorId !== 'github') {
    throw new Error('No GitHub binding is connected.');
  }
  await writeJsonAtomic(GITHUB_USER_TOKENS_FILE, {}, { mode: SECRET_FILE_MODE });
  await writeJsonAtomic(GITHUB_AUTH_STATE_PATH, {});
  return { disconnected: true };
}

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

import { createHash, randomUUID } from 'crypto';
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

function buildGitHubError(message, { code = 'CONNECTOR_GITHUB_ERROR', statusCode = 500, details = null } = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  if (details) err.details = details;
  return err;
}

function assertSafeGitHubSlug(value, fieldName = 'identifier') {
  const trimmed = trimString(value);
  if (!trimmed || trimmed === '.' || trimmed === '..' || !/^[A-Za-z0-9_.-]{1,100}$/.test(trimmed)) {
    throw buildGitHubError(`Invalid GitHub ${fieldName}.`, { code: 'CONNECTOR_INVALID_INPUT', statusCode: 400 });
  }
  return trimmed;
}

function assertPositiveInt(value, fieldName = 'number') {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw buildGitHubError(`${fieldName} must be a positive integer.`, { code: 'CONNECTOR_INVALID_INPUT', statusCode: 400 });
  }
  return num;
}

function normalizeIdempotencyMarker(idempotencyTag) {
  const raw = trimString(idempotencyTag);
  if (!raw) return '';
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function embedIdempotencyTag(body = '', idempotencyTag = '') {
  const text = typeof body === 'string' ? body.trimEnd() : '';
  const marker = normalizeIdempotencyMarker(idempotencyTag);
  if (!marker) return text;
  const tagLine = `<!-- ragent-idempotency:${marker} -->`;
  if (text.includes(tagLine)) return text;
  return text ? `${text}\n\n${tagLine}` : tagLine;
}

function hasIdempotencyTag(body = '', idempotencyTag = '') {
  const marker = normalizeIdempotencyMarker(idempotencyTag);
  if (!marker || typeof body !== 'string') return false;
  return body.includes(`<!-- ragent-idempotency:${marker} -->`);
}

async function githubApiFetch(pathname, { token, method = 'GET', body = null, headers: extraHeaders = null, signal, fetchImpl } = {}) {
  const headers = {
    Authorization: `Bearer ${trimString(token)}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {}),
  };
  if (body !== null) headers['Content-Type'] = 'application/json';
  const response = await fetchImpl(`${GITHUB_API_BASE}${pathname}`, {
    method,
    headers,
    ...(body !== null ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  if (response.status === 204) {
    return null;
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = trimString(data?.message)
      || trimString(data?.error_description)
      || `GitHub API error (HTTP ${response.status}).`;
    throw buildGitHubError(message, {
      code: response.status === 409 || response.status === 422 ? 'CONNECTOR_CONFLICT' : 'CONNECTOR_GITHUB_API_ERROR',
      statusCode: response.status,
    });
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

async function requireUserToken(fetchImpl, explicitToken = '') {
  const providedToken = trimString(explicitToken);
  if (fetchImpl && typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function.');
  }
  if (providedToken) {
    return {
      userId: '',
      login: '',
      installationId: '',
      accessToken: providedToken,
      fetchImpl: fetchImpl || fetch,
    };
  }
  const active = await loadActiveGitHubUserToken();
  if (!active?.accessToken) {
    throw new Error('GitHub is not connected. Connect the GitHub App first.');
  }
  return { ...active, fetchImpl: fetchImpl || fetch };
}

export async function listGitHubRepos({ fetchImpl, token, signal } = {}) {
  const { accessToken, fetchImpl: doFetch } = await requireUserToken(fetchImpl, token);
  const data = await githubApiFetch('/user/repos?per_page=100&sort=updated', {
    token: accessToken,
    fetchImpl: doFetch,
    signal,
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

export async function listGitHubIssues(owner, repo, { state = 'open', fetchImpl, token, signal } = {}) {
  const safeOwner = assertSafeGitHubSlug(owner, 'owner');
  const safeRepo = assertSafeGitHubSlug(repo, 'repo');
  const { accessToken, fetchImpl: doFetch } = await requireUserToken(fetchImpl, token);
  const data = await githubApiFetch(
    `/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}/issues`
    + `?state=${encodeURIComponent(trimString(state) || 'open')}&per_page=100`,
    { token: accessToken, fetchImpl: doFetch, signal },
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

export async function createGitHubIssue(owner, repo, { title = '', body = '' } = {}, { fetchImpl, token, signal } = {}) {
  const trimmedTitle = trimString(title);
  if (!trimmedTitle) {
    throw new Error('Issue title is required.');
  }
  const safeOwner = assertSafeGitHubSlug(owner, 'owner');
  const safeRepo = assertSafeGitHubSlug(repo, 'repo');
  const { accessToken, fetchImpl: doFetch } = await requireUserToken(fetchImpl, token);
  return await githubApiFetch(
    `/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}/issues`,
    {
      method: 'POST',
      token: accessToken,
      body: { title: trimmedTitle, ...(trimString(body) ? { body: trimString(body) } : {}) },
      fetchImpl: doFetch,
      signal,
    },
  );
}

export async function listGitHubPulls(owner, repo, { state = 'open', head = '', base = '', fetchImpl, token, signal } = {}) {
  const safeOwner = assertSafeGitHubSlug(owner, 'owner');
  const safeRepo = assertSafeGitHubSlug(repo, 'repo');
  const { accessToken, fetchImpl: doFetch } = await requireUserToken(fetchImpl, token);
  const query = new URLSearchParams({
    state: trimString(state) || 'open',
    per_page: '100',
  });
  if (trimString(head)) query.set('head', trimString(head));
  if (trimString(base)) query.set('base', trimString(base));
  const data = await githubApiFetch(
    `/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}/pulls?${query.toString()}`,
    { token: accessToken, fetchImpl: doFetch, signal },
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

function normalizeGitHubPullDetail(pull = {}) {
  return {
    number: Number.isInteger(Number(pull.number)) ? Number(pull.number) : 0,
    title: trimString(pull.title),
    body: typeof pull.body === 'string' ? pull.body : '',
    state: trimString(pull.state),
    draft: pull.draft === true,
    merged: pull.merged === true || Boolean(trimString(pull.merged_at)),
    mergeable: pull.mergeable === undefined ? null : pull.mergeable,
    mergeCommitSha: trimString(pull.merge_commit_sha),
    user: trimString(pull.user?.login),
    headRef: trimString(pull.head?.ref),
    headSha: trimString(pull.head?.sha),
    baseRef: trimString(pull.base?.ref),
    createdAt: trimString(pull.created_at),
    updatedAt: trimString(pull.updated_at),
    mergedAt: trimString(pull.merged_at),
    htmlUrl: trimString(pull.html_url),
  };
}

export async function getGitHubPull(owner, repo, pullNumber, { fetchImpl, token, signal } = {}) {
  const safeOwner = assertSafeGitHubSlug(owner, 'owner');
  const safeRepo = assertSafeGitHubSlug(repo, 'repo');
  const number = assertPositiveInt(pullNumber, 'Pull request number');
  const { accessToken, fetchImpl: doFetch } = await requireUserToken(fetchImpl, token);
  const data = await githubApiFetch(
    `/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}/pulls/${number}`,
    { token: accessToken, fetchImpl: doFetch, signal },
  );
  return normalizeGitHubPullDetail(data);
}

export async function createGitHubPull(
  owner,
  repo,
  { title = '', head = '', base = '', body = '', draft = false, maintainerCanModify = true, idempotencyTag = '' } = {},
  { fetchImpl, token, signal, onBeforeWire } = {},
) {
  const safeOwner = assertSafeGitHubSlug(owner, 'owner');
  const safeRepo = assertSafeGitHubSlug(repo, 'repo');
  const trimmedTitle = trimString(title);
  const trimmedHead = trimString(head);
  const trimmedBase = trimString(base);
  if (!trimmedTitle) {
    throw buildGitHubError('Pull request title is required.', { code: 'CONNECTOR_INVALID_INPUT', statusCode: 400 });
  }
  if (!trimmedHead || !trimmedBase) {
    throw buildGitHubError('Pull request head and base branches are required.', { code: 'CONNECTOR_INVALID_INPUT', statusCode: 400 });
  }
  const { accessToken, fetchImpl: doFetch } = await requireUserToken(fetchImpl, token);
  const taggedBody = embedIdempotencyTag(body, idempotencyTag);
  if (typeof onBeforeWire === 'function') await onBeforeWire();
  const data = await githubApiFetch(
    `/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}/pulls`,
    {
      method: 'POST',
      token: accessToken,
      body: {
        title: trimmedTitle,
        head: trimmedHead,
        base: trimmedBase,
        ...(taggedBody ? { body: taggedBody } : {}),
        draft: draft === true,
        maintainer_can_modify: maintainerCanModify !== false,
      },
      fetchImpl: doFetch,
      signal,
    },
  );
  if (!Number.isInteger(Number(data?.number)) || Number(data.number) <= 0) {
    throw buildGitHubError('GitHub PR creation did not return an authoritative PR number.', {
      code: 'CONNECTOR_RECEIPT_MISSING',
      statusCode: 502,
    });
  }
  return normalizeGitHubPullDetail(data);
}

export async function updateGitHubPull(
  owner,
  repo,
  pullNumber,
  { title, body, state, base, maintainerCanModify, expectedHeadSha = '', idempotencyTag = '' } = {},
  { fetchImpl, token, signal, onBeforeWire } = {},
) {
  const safeOwner = assertSafeGitHubSlug(owner, 'owner');
  const safeRepo = assertSafeGitHubSlug(repo, 'repo');
  const number = assertPositiveInt(pullNumber, 'Pull request number');
  if (state !== undefined && !['open', 'closed'].includes(trimString(state).toLowerCase())) {
    throw buildGitHubError('Pull request state must be "open" or "closed".', { code: 'CONNECTOR_INVALID_INPUT', statusCode: 400 });
  }
  const patchBody = {};
  if (title !== undefined) {
    const trimmedTitle = trimString(title);
    if (!trimmedTitle) throw buildGitHubError('Pull request title cannot be empty.', { code: 'CONNECTOR_INVALID_INPUT', statusCode: 400 });
    patchBody.title = trimmedTitle;
  }
  if (body !== undefined) {
    patchBody.body = embedIdempotencyTag(String(body), idempotencyTag);
  } else if (idempotencyTag) {
    // Preserve tag on update only when body is explicitly updated or fetched below.
  }
  if (state !== undefined) patchBody.state = trimString(state).toLowerCase();
  if (base !== undefined) {
    const trimmedBase = trimString(base);
    if (!trimmedBase) throw buildGitHubError('Pull request base branch cannot be empty.', { code: 'CONNECTOR_INVALID_INPUT', statusCode: 400 });
    patchBody.base = trimmedBase;
  }
  if (typeof maintainerCanModify === 'boolean') patchBody.maintainer_can_modify = maintainerCanModify;
  if (Object.keys(patchBody).length === 0) {
    throw buildGitHubError('At least one pull request field to update is required.', { code: 'CONNECTOR_INVALID_INPUT', statusCode: 400 });
  }

  const { accessToken, fetchImpl: doFetch } = await requireUserToken(fetchImpl, token);
  if (trimString(expectedHeadSha)) {
    const current = await getGitHubPull(safeOwner, safeRepo, number, { fetchImpl: doFetch, token: accessToken, signal });
    if (current.headSha !== trimString(expectedHeadSha)) {
      throw buildGitHubError(
        `Pull request #${number} head SHA conflict: expected ${trimString(expectedHeadSha)}, found ${current.headSha || 'unknown'}.`,
        {
          code: 'CONNECTOR_CONFLICT',
          statusCode: 409,
          details: { expectedHeadSha: trimString(expectedHeadSha), actualHeadSha: current.headSha },
        },
      );
    }
  }
  if (typeof onBeforeWire === 'function') await onBeforeWire();
  const data = await githubApiFetch(
    `/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}/pulls/${number}`,
    {
      method: 'PATCH',
      token: accessToken,
      body: patchBody,
      fetchImpl: doFetch,
      signal,
    },
  );
  if (!Number.isInteger(Number(data?.number)) || Number(data.number) <= 0) {
    throw buildGitHubError('GitHub PR update did not return an authoritative PR number.', {
      code: 'CONNECTOR_RECEIPT_MISSING',
      statusCode: 502,
    });
  }
  return normalizeGitHubPullDetail(data);
}

export async function createGitHubPullComment(
  owner,
  repo,
  pullNumber,
  body = '',
  { idempotencyTag = '', fetchImpl, token, signal, onBeforeWire } = {},
) {
  const safeOwner = assertSafeGitHubSlug(owner, 'owner');
  const safeRepo = assertSafeGitHubSlug(repo, 'repo');
  const number = assertPositiveInt(pullNumber, 'Pull request number');
  const trimmedBody = trimString(body);
  if (!trimmedBody) {
    throw buildGitHubError('Comment body is required.', { code: 'CONNECTOR_INVALID_INPUT', statusCode: 400 });
  }
  const { accessToken, fetchImpl: doFetch } = await requireUserToken(fetchImpl, token);
  const taggedBody = embedIdempotencyTag(trimmedBody, idempotencyTag);
  if (typeof onBeforeWire === 'function') await onBeforeWire();
  const data = await githubApiFetch(
    `/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}/issues/${number}/comments`,
    {
      method: 'POST',
      token: accessToken,
      body: { body: taggedBody },
      fetchImpl: doFetch,
      signal,
    },
  );
  if (!data?.id) {
    throw buildGitHubError('GitHub PR comment did not return an authoritative comment ID.', {
      code: 'CONNECTOR_RECEIPT_MISSING',
      statusCode: 502,
    });
  }
  return {
    id: data.id,
    pullNumber: number,
    body: typeof data.body === 'string' ? data.body : taggedBody,
    htmlUrl: trimString(data.html_url),
    createdAt: trimString(data.created_at),
  };
}

export async function mergeGitHubPull(
  owner,
  repo,
  pullNumber,
  { commitTitle = '', commitMessage = '', mergeMethod = 'merge', sha = '' } = {},
  { fetchImpl, token, signal, onBeforeWire } = {},
) {
  const safeOwner = assertSafeGitHubSlug(owner, 'owner');
  const safeRepo = assertSafeGitHubSlug(repo, 'repo');
  const number = assertPositiveInt(pullNumber, 'Pull request number');
  const method = trimString(mergeMethod).toLowerCase() || 'merge';
  if (!['merge', 'squash', 'rebase'].includes(method)) {
    throw buildGitHubError('mergeMethod must be merge, squash, or rebase.', { code: 'CONNECTOR_INVALID_INPUT', statusCode: 400 });
  }
  const expectedSha = trimString(sha);
  if (!expectedSha) {
    throw buildGitHubError('Pull request head SHA is required before merging.', { code: 'CONNECTOR_INVALID_INPUT', statusCode: 400 });
  }
  const { accessToken, fetchImpl: doFetch } = await requireUserToken(fetchImpl, token);
  const current = await getGitHubPull(safeOwner, safeRepo, number, { fetchImpl: doFetch, token: accessToken, signal });
  if (current.merged) {
    throw buildGitHubError(`Pull request #${number} is already merged.`, { code: 'CONNECTOR_CONFLICT', statusCode: 409 });
  }
  if (current.state !== 'open') {
    throw buildGitHubError(`Pull request #${number} is ${current.state || 'not open'}.`, { code: 'CONNECTOR_CONFLICT', statusCode: 409 });
  }
  if (current.headSha && current.headSha !== expectedSha) {
    throw buildGitHubError(
      `Pull request #${number} head SHA conflict: expected ${expectedSha}, found ${current.headSha}.`,
      {
        code: 'CONNECTOR_CONFLICT',
        statusCode: 409,
        details: { expectedSha, actualHeadSha: current.headSha },
      },
    );
  }

  const requestBody = {
    merge_method: method,
    sha: expectedSha,
    ...(trimString(commitTitle) ? { commit_title: trimString(commitTitle) } : {}),
    ...(trimString(commitMessage) ? { commit_message: trimString(commitMessage) } : {}),
  };
  if (typeof onBeforeWire === 'function') await onBeforeWire();
  const data = await githubApiFetch(
    `/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}/pulls/${number}/merge`,
    {
      method: 'PUT',
      token: accessToken,
      body: requestBody,
      fetchImpl: doFetch,
      signal,
    },
  );
  if (data?.merged !== true || !trimString(data?.sha)) {
    throw buildGitHubError('GitHub PR merge did not return an authoritative merge receipt.', {
      code: 'CONNECTOR_RECEIPT_MISSING',
      statusCode: 502,
    });
  }
  return {
    merged: true,
    pullNumber: number,
    sha: trimString(data.sha),
    message: trimString(data.message),
  };
}

export async function findGitHubPullReceipt(
  owner,
  repo,
  { actionKind = 'create', pullNumber, head = '', base = '', title = '', state = '', idempotencyTag = '', expectedSha = '', body = '', fetchImpl, token, signal } = {},
) {
  const safeOwner = assertSafeGitHubSlug(owner, 'owner');
  const safeRepo = assertSafeGitHubSlug(repo, 'repo');
  const { accessToken, fetchImpl: doFetch } = await requireUserToken(fetchImpl, token);

  if (actionKind === 'create') {
    if (Number.isInteger(Number(pullNumber)) && Number(pullNumber) > 0) {
      const pr = await getGitHubPull(safeOwner, safeRepo, pullNumber, { fetchImpl: doFetch, token: accessToken, signal }).catch(() => null);
      if (pr && (!idempotencyTag || hasIdempotencyTag(pr.body, idempotencyTag))) {
        return { verified: true, externalId: String(pr.number), receipt: pr };
      }
    }
    const query = new URLSearchParams({ state: 'all', per_page: '100' });
    if (trimString(head)) query.set('head', trimString(head).includes(':') ? trimString(head) : `${safeOwner}:${trimString(head)}`);
    if (trimString(base)) query.set('base', trimString(base));
    const list = await githubApiFetch(
      `/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}/pulls?${query.toString()}`,
      { token: accessToken, fetchImpl: doFetch, signal },
    );
    if (!Array.isArray(list)) return null;
    const match = list.find((pull) => {
      if (idempotencyTag && hasIdempotencyTag(pull.body || '', idempotencyTag)) return true;
      if (!idempotencyTag) {
        return (!trimString(head) || trimString(pull.head?.ref) === trimString(head))
          && (!trimString(base) || trimString(pull.base?.ref) === trimString(base))
          && (!trimString(title) || trimString(pull.title) === trimString(title));
      }
      return false;
    });
    if (!match?.number) return null;
    const normalized = normalizeGitHubPullDetail(match);
    return { verified: true, externalId: String(normalized.number), receipt: normalized };
  }

  const number = assertPositiveInt(pullNumber, 'Pull request number');
  if (actionKind === 'update') {
    const pr = await getGitHubPull(safeOwner, safeRepo, number, { fetchImpl: doFetch, token: accessToken, signal }).catch(() => null);
    if (!pr) return null;
    if (title !== undefined && trimString(title) && pr.title !== trimString(title)) return null;
    if (state !== undefined && trimString(state) && pr.state !== trimString(state).toLowerCase()) return null;
    if (base !== undefined && trimString(base) && pr.baseRef !== trimString(base)) return null;
    if (idempotencyTag && body !== undefined && !hasIdempotencyTag(pr.body, idempotencyTag)) return null;
    return { verified: true, externalId: String(pr.number), receipt: pr };
  }

  if (actionKind === 'comment') {
    const comments = await githubApiFetch(
      `/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}/issues/${number}/comments?per_page=100`,
      { token: accessToken, fetchImpl: doFetch, signal },
    ).catch(() => null);
    if (!Array.isArray(comments)) return null;
    const match = comments.find((comment) => {
      if (idempotencyTag && hasIdempotencyTag(comment.body || '', idempotencyTag)) return true;
      if (!idempotencyTag && trimString(body)) return trimString(comment.body) === trimString(body);
      return false;
    });
    if (!match?.id) return null;
    return {
      verified: true,
      externalId: String(match.id),
      receipt: {
        id: match.id,
        pullNumber: number,
        body: typeof match.body === 'string' ? match.body : '',
        htmlUrl: trimString(match.html_url),
      },
    };
  }

  if (actionKind === 'merge') {
    const pr = await getGitHubPull(safeOwner, safeRepo, number, { fetchImpl: doFetch, token: accessToken, signal }).catch(() => null);
    if (!pr || pr.merged !== true) return null;
    if (trimString(expectedSha) && pr.headSha && pr.headSha !== trimString(expectedSha)) return null;
    return {
      verified: true,
      externalId: pr.mergeCommitSha || String(pr.number),
      receipt: pr,
    };
  }

  return null;
}

export async function createGitHubIssueComment(owner, repo, issueNumber, body = '', { fetchImpl, token, signal } = {}) {
  const trimmedBody = trimString(body);
  if (!trimmedBody) {
    throw new Error('Comment body is required.');
  }
  const safeOwner = assertSafeGitHubSlug(owner, 'owner');
  const safeRepo = assertSafeGitHubSlug(repo, 'repo');
  const number = Number(issueNumber);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error('Issue number must be a positive integer.');
  }
  const { accessToken, fetchImpl: doFetch } = await requireUserToken(fetchImpl, token);
  return await githubApiFetch(
    `/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}`
    + `/issues/${number}/comments`,
    {
      method: 'POST',
      token: accessToken,
      body: { body: trimmedBody },
      fetchImpl: doFetch,
      signal,
    },
  );
}

export async function getGitHubActionsStatus(owner, repo, { perPage = 10, fetchImpl, token, signal } = {}) {
  const safeOwner = assertSafeGitHubSlug(owner, 'owner');
  const safeRepo = assertSafeGitHubSlug(repo, 'repo');
  const { accessToken, fetchImpl: doFetch } = await requireUserToken(fetchImpl, token);
  const data = await githubApiFetch(
    `/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}/actions/runs`
    + `?per_page=${Number.isFinite(Number(perPage)) ? Math.min(Math.max(1, Number(perPage)), 50) : 10}`,
    { token: accessToken, fetchImpl: doFetch, signal },
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

export const GITHUB_ACTION_CONTRACTS = Object.freeze({
  'github.repo.list': Object.freeze({
    capability: 'github.repo.list',
    connectorId: 'github',
    actionClass: 'read',
    riskLevel: 'read',
    confirmationPolicy: 'auto_within_policy',
    timeoutMs: 15_000,
    receiptVerifier: Object.freeze({
      kind: 'none_readonly',
      supported: false,
      description: 'Read-only repository list requires no external mutation receipt.',
    }),
    compensation: Object.freeze({
      supported: false,
      mode: 'none_readonly',
      description: 'Read-only action has no side effects to compensate.',
    }),
  }),
  'github.issue.list': Object.freeze({
    capability: 'github.issue.list',
    connectorId: 'github',
    actionClass: 'read',
    riskLevel: 'read',
    confirmationPolicy: 'auto_within_policy',
    timeoutMs: 15_000,
    receiptVerifier: Object.freeze({
      kind: 'none_readonly',
      supported: false,
      description: 'Read-only issue list requires no external mutation receipt.',
    }),
    compensation: Object.freeze({
      supported: false,
      mode: 'none_readonly',
      description: 'Read-only action has no side effects to compensate.',
    }),
  }),
  'github.pull.list': Object.freeze({
    capability: 'github.pull.list',
    connectorId: 'github',
    actionClass: 'read',
    riskLevel: 'read',
    confirmationPolicy: 'auto_within_policy',
    timeoutMs: 15_000,
    receiptVerifier: Object.freeze({
      kind: 'none_readonly',
      supported: false,
      description: 'Read-only pull request list requires no external mutation receipt.',
    }),
    compensation: Object.freeze({
      supported: false,
      mode: 'none_readonly',
      description: 'Read-only action has no side effects to compensate.',
    }),
  }),
  'github.pull.get': Object.freeze({
    capability: 'github.pull.get',
    connectorId: 'github',
    actionClass: 'read',
    riskLevel: 'read',
    confirmationPolicy: 'auto_within_policy',
    timeoutMs: 15_000,
    receiptVerifier: Object.freeze({
      kind: 'none_readonly',
      supported: false,
      description: 'Read-only pull request fetch requires no external mutation receipt.',
    }),
    compensation: Object.freeze({
      supported: false,
      mode: 'none_readonly',
      description: 'Read-only action has no side effects to compensate.',
    }),
  }),
  'github.actions.status': Object.freeze({
    capability: 'github.actions.status',
    connectorId: 'github',
    actionClass: 'read',
    riskLevel: 'read',
    confirmationPolicy: 'auto_within_policy',
    timeoutMs: 15_000,
    receiptVerifier: Object.freeze({
      kind: 'none_readonly',
      supported: false,
      description: 'Read-only workflow status fetch requires no external mutation receipt.',
    }),
    compensation: Object.freeze({
      supported: false,
      mode: 'none_readonly',
      description: 'Read-only action has no side effects to compensate.',
    }),
  }),
  'github.pr.create': Object.freeze({
    capability: 'github.pr.create',
    connectorId: 'github',
    actionClass: 'broadcast',
    riskLevel: 'external_broadcast',
    confirmationPolicy: 'require_approval',
    timeoutMs: 20_000,
    receiptVerifier: Object.freeze({
      kind: 'provider_lookup',
      supported: true,
      description: 'Verify created PR via GitHub pulls lookup matching idempotency marker and branch pair.',
    }),
    compensation: Object.freeze({
      supported: true,
      mode: 'compensating_action',
      compensatingCapability: 'github.pr.update',
      description: 'Close the created PR via github.pr.update (state=closed); external notifications remain delivered.',
    }),
  }),
  'github.pr.update': Object.freeze({
    capability: 'github.pr.update',
    connectorId: 'github',
    actionClass: 'write',
    riskLevel: 'reversible_write',
    confirmationPolicy: 'require_approval',
    timeoutMs: 20_000,
    receiptVerifier: Object.freeze({
      kind: 'provider_lookup',
      supported: true,
      description: 'Verify updated PR attributes via GitHub pull get.',
    }),
    compensation: Object.freeze({
      supported: true,
      mode: 'compensating_action',
      compensatingCapability: 'github.pr.update',
      description: 'Revert pull request title, body, base branch, or state via github.pr.update.',
    }),
  }),
  'github.pr.comment': Object.freeze({
    capability: 'github.pr.comment',
    connectorId: 'github',
    actionClass: 'broadcast',
    riskLevel: 'external_broadcast',
    confirmationPolicy: 'require_approval',
    timeoutMs: 20_000,
    receiptVerifier: Object.freeze({
      kind: 'provider_lookup',
      supported: true,
      description: 'Verify posted PR comment via GitHub issue comments lookup matching idempotency marker.',
    }),
    compensation: Object.freeze({
      supported: false,
      mode: 'manual_only',
      description: 'GitHub PR comments notify subscribers immediately and require manual deletion.',
    }),
  }),
  'github.pr.merge': Object.freeze({
    capability: 'github.pr.merge',
    connectorId: 'github',
    actionClass: 'broadcast',
    riskLevel: 'irreversible_write',
    confirmationPolicy: 'require_approval',
    timeoutMs: 25_000,
    receiptVerifier: Object.freeze({
      kind: 'provider_lookup',
      supported: true,
      description: 'Verify pull request merged status and merge commit SHA via GitHub pull get.',
    }),
    compensation: Object.freeze({
      supported: false,
      mode: 'irreversible',
      description: 'Merging a pull request permanently updates the target branch and cannot be automatically unmerged.',
    }),
  }),
});

export function createGitHubConnectorAction(capability, params = {}, options = {}) {
  const template = GITHUB_ACTION_CONTRACTS[capability];
  if (!template) {
    throw buildGitHubError(`Unknown GitHub connector capability: ${capability}`, {
      code: 'CONNECTOR_UNSUPPORTED_CAPABILITY',
      statusCode: 400,
    });
  }
  const idempotencyKey = trimString(options.idempotencyKey || params.idempotencyKey);
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : template.timeoutMs;
  const confirmationPolicy = trimString(options.confirmationPolicy) || template.confirmationPolicy;
  const owner = trimString(params.owner);
  const repo = trimString(params.repo);
  const repository = owner && repo ? `${owner}/${repo}` : '';

  const scope = {
    connectorId: 'github',
    resource: repository || 'account:repos',
    ...(repository ? { repository, owner, repo } : {}),
    ...(params.base ? { base: trimString(params.base) } : {}),
    ...(params.head ? { head: trimString(params.head) } : {}),
    ...(params.pullNumber ? { pullNumber: Number(params.pullNumber) } : {}),
  };

  if (capability === 'github.repo.list') {
    return {
      contract: {
        ...template,
        idempotencyKey,
        confirmationPolicy,
        timeoutMs,
        scope,
      },
      payload: {},
      execute: async (ctx = {}) => await listGitHubRepos({
        fetchImpl: ctx.fetchImpl || options.fetchImpl,
        token: ctx.token || options.token,
        signal: ctx.signal,
      }),
    };
  }

  assertSafeGitHubSlug(owner, 'owner');
  assertSafeGitHubSlug(repo, 'repo');

  if (capability === 'github.issue.list') {
    const state = trimString(params.state) || 'open';
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope },
      payload: { owner, repo, state },
      execute: async (ctx = {}) => await listGitHubIssues(owner, repo, {
        state,
        fetchImpl: ctx.fetchImpl || options.fetchImpl,
        token: ctx.token || options.token,
        signal: ctx.signal,
      }),
    };
  }

  if (capability === 'github.pull.list') {
    const state = trimString(params.state) || 'open';
    const head = trimString(params.head);
    const base = trimString(params.base);
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope },
      payload: { owner, repo, state, head, base },
      execute: async (ctx = {}) => await listGitHubPulls(owner, repo, {
        state,
        head,
        base,
        fetchImpl: ctx.fetchImpl || options.fetchImpl,
        token: ctx.token || options.token,
        signal: ctx.signal,
      }),
    };
  }

  if (capability === 'github.pull.get') {
    const pullNumber = assertPositiveInt(params.pullNumber, 'Pull request number');
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope },
      payload: { owner, repo, pullNumber },
      execute: async (ctx = {}) => await getGitHubPull(owner, repo, pullNumber, {
        fetchImpl: ctx.fetchImpl || options.fetchImpl,
        token: ctx.token || options.token,
        signal: ctx.signal,
      }),
    };
  }

  if (capability === 'github.actions.status') {
    const perPage = params.perPage ?? 10;
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope },
      payload: { owner, repo, perPage },
      execute: async (ctx = {}) => await getGitHubActionsStatus(owner, repo, {
        perPage,
        fetchImpl: ctx.fetchImpl || options.fetchImpl,
        token: ctx.token || options.token,
        signal: ctx.signal,
      }),
    };
  }

  if (capability === 'github.pr.create') {
    const title = trimString(params.title);
    const head = trimString(params.head);
    const base = trimString(params.base);
    const body = typeof params.body === 'string' ? params.body : '';
    const draft = params.draft === true;
    const maintainerCanModify = params.maintainerCanModify !== false;
    const receiptVerifier = {
      ...template.receiptVerifier,
      verify: async (ctx = {}) => await findGitHubPullReceipt(owner, repo, {
        actionKind: 'create',
        pullNumber: ctx.result?.number || ctx.externalId,
        head,
        base,
        title,
        idempotencyTag: idempotencyKey,
        fetchImpl: ctx.fetchImpl || options.fetchImpl,
        token: ctx.token || options.token,
        signal: ctx.signal,
      }),
    };
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope, receiptVerifier },
      payload: { owner, repo, title, head, base, body, draft, maintainerCanModify },
      execute: async (ctx = {}) => {
        const pr = await createGitHubPull(
          owner,
          repo,
          { title, head, base, body, draft, maintainerCanModify, idempotencyTag: idempotencyKey },
          {
            fetchImpl: ctx.fetchImpl || options.fetchImpl,
            token: ctx.token || options.token,
            signal: ctx.signal,
            onBeforeWire: ctx.onBeforeWire,
          },
        );
        return { ...pr, externalId: String(pr.number) };
      },
    };
  }

  if (capability === 'github.pr.update') {
    const pullNumber = assertPositiveInt(params.pullNumber, 'Pull request number');
    const expectedHeadSha = trimString(params.expectedHeadSha);
    const updateInput = {
      ...(params.title !== undefined ? { title: params.title } : {}),
      ...(params.body !== undefined ? { body: params.body } : {}),
      ...(params.state !== undefined ? { state: params.state } : {}),
      ...(params.base !== undefined ? { base: params.base } : {}),
      ...(typeof params.maintainerCanModify === 'boolean' ? { maintainerCanModify: params.maintainerCanModify } : {}),
      ...(expectedHeadSha ? { expectedHeadSha } : {}),
      idempotencyTag: idempotencyKey,
    };
    const receiptVerifier = {
      ...template.receiptVerifier,
      verify: async (ctx = {}) => await findGitHubPullReceipt(owner, repo, {
        actionKind: 'update',
        pullNumber,
        title: params.title,
        state: params.state,
        base: params.base,
        body: params.body,
        idempotencyTag: params.body !== undefined ? idempotencyKey : '',
        fetchImpl: ctx.fetchImpl || options.fetchImpl,
        token: ctx.token || options.token,
        signal: ctx.signal,
      }),
    };
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope, receiptVerifier },
      payload: { owner, repo, pullNumber, ...updateInput },
      precheck: async (ctx = {}) => {
        if (!expectedHeadSha) return { ok: true };
        const current = await getGitHubPull(owner, repo, pullNumber, {
          fetchImpl: ctx.fetchImpl || options.fetchImpl,
          token: ctx.token || options.token,
          signal: ctx.signal,
        });
        if (current.headSha !== expectedHeadSha) {
          throw buildGitHubError(
            `Pull request #${pullNumber} head SHA conflict: expected ${expectedHeadSha}, found ${current.headSha || 'unknown'}.`,
            { code: 'CONNECTOR_CONFLICT', statusCode: 409 },
          );
        }
        return { ok: true, current };
      },
      execute: async (ctx = {}) => {
        const pr = await updateGitHubPull(owner, repo, pullNumber, updateInput, {
          fetchImpl: ctx.fetchImpl || options.fetchImpl,
          token: ctx.token || options.token,
          signal: ctx.signal,
          onBeforeWire: ctx.onBeforeWire,
        });
        return { ...pr, externalId: String(pr.number) };
      },
    };
  }

  if (capability === 'github.pr.comment') {
    const pullNumber = assertPositiveInt(params.pullNumber, 'Pull request number');
    const body = trimString(params.body);
    const receiptVerifier = {
      ...template.receiptVerifier,
      verify: async (ctx = {}) => await findGitHubPullReceipt(owner, repo, {
        actionKind: 'comment',
        pullNumber,
        body,
        idempotencyTag: idempotencyKey,
        fetchImpl: ctx.fetchImpl || options.fetchImpl,
        token: ctx.token || options.token,
        signal: ctx.signal,
      }),
    };
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope, receiptVerifier },
      payload: { owner, repo, pullNumber, body },
      execute: async (ctx = {}) => {
        const comment = await createGitHubPullComment(owner, repo, pullNumber, body, {
          idempotencyTag: idempotencyKey,
          fetchImpl: ctx.fetchImpl || options.fetchImpl,
          token: ctx.token || options.token,
          signal: ctx.signal,
          onBeforeWire: ctx.onBeforeWire,
        });
        return { ...comment, externalId: String(comment.id) };
      },
    };
  }

  if (capability === 'github.pr.merge') {
    const pullNumber = assertPositiveInt(params.pullNumber, 'Pull request number');
    const sha = trimString(params.sha);
    const mergeMethod = trimString(params.mergeMethod).toLowerCase() || 'merge';
    const commitTitle = trimString(params.commitTitle);
    const commitMessage = trimString(params.commitMessage);
    const receiptVerifier = {
      ...template.receiptVerifier,
      verify: async (ctx = {}) => await findGitHubPullReceipt(owner, repo, {
        actionKind: 'merge',
        pullNumber,
        expectedSha: sha,
        fetchImpl: ctx.fetchImpl || options.fetchImpl,
        token: ctx.token || options.token,
        signal: ctx.signal,
      }),
    };
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope, receiptVerifier },
      payload: { owner, repo, pullNumber, sha, mergeMethod, commitTitle, commitMessage },
      precheck: async (ctx = {}) => {
        if (!sha) {
          throw buildGitHubError('Pull request head SHA is required before merging.', { code: 'CONNECTOR_INVALID_INPUT', statusCode: 400 });
        }
        const current = await getGitHubPull(owner, repo, pullNumber, {
          fetchImpl: ctx.fetchImpl || options.fetchImpl,
          token: ctx.token || options.token,
          signal: ctx.signal,
        });
        if (current.merged) {
          throw buildGitHubError(`Pull request #${pullNumber} is already merged.`, { code: 'CONNECTOR_CONFLICT', statusCode: 409 });
        }
        if (current.state !== 'open') {
          throw buildGitHubError(`Pull request #${pullNumber} is not open.`, { code: 'CONNECTOR_CONFLICT', statusCode: 409 });
        }
        if (current.headSha && current.headSha !== sha) {
          throw buildGitHubError(
            `Pull request #${pullNumber} head SHA conflict: expected ${sha}, found ${current.headSha}.`,
            { code: 'CONNECTOR_CONFLICT', statusCode: 409 },
          );
        }
        return { ok: true, current };
      },
      execute: async (ctx = {}) => {
        const merged = await mergeGitHubPull(
          owner,
          repo,
          pullNumber,
          { sha, mergeMethod, commitTitle, commitMessage },
          {
            fetchImpl: ctx.fetchImpl || options.fetchImpl,
            token: ctx.token || options.token,
            signal: ctx.signal,
            onBeforeWire: ctx.onBeforeWire,
          },
        );
        return { ...merged, externalId: merged.sha };
      },
    };
  }

  throw buildGitHubError(`Unsupported GitHub connector capability: ${capability}`, {
    code: 'CONNECTOR_UNSUPPORTED_CAPABILITY',
    statusCode: 400,
  });
}

export async function executeGitHubConnectorAction(capability, params = {}, context = {}) {
  const { dispatchConnectorAction } = await import('./connector-action-dispatcher.mjs');
  const action = createGitHubConnectorAction(capability, params, {
    idempotencyKey: context.idempotencyKey || params.idempotencyKey,
    timeoutMs: context.timeoutMs,
    confirmationPolicy: context.confirmationPolicy,
    fetchImpl: context.fetchImpl,
    token: context.token,
  });
  return await dispatchConnectorAction(action, context);
}

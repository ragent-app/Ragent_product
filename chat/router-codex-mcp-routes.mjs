// Codex MCP server management routes: the Connector panel lists, adds and
// removes the user's codex mcp_servers through the codex CLI. Owner-only —
// these endpoints manage the service user's ~/.codex configuration.
import { readBody } from '../lib/utils.mjs';
import { dirname, join } from 'node:path';
import { CONFIG_DIR, CODEX_MANAGED_HOME_DIR } from '../lib/config.mjs';
import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';
import { ensureManagedCodexMcpBinding, managedCodexMcpAccountBinding, withManagedCodexMcpLock } from '../lib/provider-runtime/codex-mcp-config.mjs';
import { WORKBENCH_EXECUTION_POLICY } from '../lib/workbench-execution-policy.mjs';
import { nativeCodexAccountId, nativeProviderHomeRoot, resolveCodexAccountHomeRoot } from '../lib/provider-runtime/provider-home.mjs';
import { readCodexPluginPreference, writeCodexPluginPreference } from '../lib/provider-runtime/codex-plugin-preferences.mjs';
import { retireIdleCodexBrokerForPluginChange } from './codex-plugin-restart.mjs';
import { readCodexCapabilitySync, refreshCodexCapabilitySync, readCodexSyncPolicy, writeCodexSyncPolicy, scheduleCodexCapabilitySync } from './codex-capability-sync.mjs';
import { beginCodexMcpOAuth, readCodexMcpOAuth, cancelCodexMcpOAuth, forwardCodexMcpOAuthCallback } from './codex-mcp-oauth.mjs';
import {
  addCodexMcpServer,
  listCodexMcpServers,
  removeCodexMcpServer,
} from '../lib/codex-mcp-manager.mjs';

const CODEX_MCP_BODY_MAX_BYTES = 4096;

function isCodexMcpListRoute(pathname) {
  return pathname === '/api/codex/mcp-servers' && true;
}

export function parseCodexMcpServerDeleteRoute(pathname) {
  const match = /^\/api\/codex\/mcp-servers\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export async function handleCodexMcpRoutes({
  req,
  res,
  pathname,
  authSession,
  writeJson,
}) {
  const pluginMatch = /^\/api\/providers\/([^/]+)\/codex\/(plugin-preference|capability-sync|capability-sync-policy)$/.exec(pathname);
  if (pluginMatch) {
    if (authSession?.role !== 'owner') { writeJson(res, 403, { error: 'Owner access required' }); return true; }
    if (WORKBENCH_EXECUTION_POLICY) { writeJson(res, 403, { error: 'Plugin management is locked by the workbench operator', code: 'WORKBENCH_EXECUTION_POLICY_DENIED' }); return true; }
    if (!['GET', 'POST'].includes(req.method)) { writeJson(res, 405, { error: 'Unsupported method' }); return true; }
    let providerId;
    try { providerId = decodeURIComponent(pluginMatch[1]); } catch { writeJson(res, 400, { error: 'Invalid provider id' }); return true; }
    const registry = createNativeProviderRegistry({ configDir: CONFIG_DIR });
    const profile = await registry.getProviderProfile(providerId).catch(() => null);
    if (!profile || profile.agentType !== 'codex') { writeJson(res, 404, { error: 'Codex provider not found' }); return true; }
    const auth = await registry.getAuthProfile(profile.authProfileId).catch(() => null);
    const secret = auth?.storageRef ? await createSecretStore({ configDir: CONFIG_DIR }).resolveSecret(auth.storageRef).catch(() => null) : null;
    const binding = secret?.authType === 'oauth' ? managedCodexMcpAccountBinding(secret) : '';
    if (!binding) { writeJson(res, 409, { error: 'A verified Codex OAuth account is required', code: 'CODEX_PLUGIN_ACCOUNT_UNVERIFIED' }); return true; }
    try {
      if (pluginMatch[2] === 'capability-sync-policy') {
        let mode = await readCodexSyncPolicy(CONFIG_DIR, binding);
        if (req.method === 'POST') {
          let body;
          try { body = JSON.parse(await readBody(req, CODEX_MCP_BODY_MAX_BYTES)); }
          catch { writeJson(res, 400, { error: 'Invalid JSON body' }); return true; }
          if (!['approved-auto', 'manual', 'disabled'].includes(body?.mode)) { writeJson(res, 400, { error: 'Invalid synchronization policy' }); return true; }
          const latestProfile = await registry.getProviderProfile(providerId);
          const latestAuth = latestProfile?.authProfileId ? await registry.getAuthProfile(latestProfile.authProfileId) : null;
          const latest = latestAuth?.storageRef ? await createSecretStore({ configDir: CONFIG_DIR }).resolveSecret(latestAuth.storageRef) : null;
          if (latestProfile?.agentType !== 'codex' || managedCodexMcpAccountBinding(latest) !== binding) {
            writeJson(res, 409, { error: 'Codex account changed', code: 'CODEX_SYNC_ACCOUNT_CHANGED' }); return true;
          }
          mode = await writeCodexSyncPolicy(CONFIG_DIR, binding, body.mode);
          if (mode === 'approved-auto') scheduleCodexCapabilitySync(providerId, { configDir: CONFIG_DIR, registry });
        }
        writeJson(res, 200, { mode, scope: 'account' });
        return true;
      }
      if (pluginMatch[2] === 'capability-sync') {
        const mode = await readCodexSyncPolicy(CONFIG_DIR, binding);
        if (req.method === 'POST' && mode === 'disabled') { writeJson(res, 409, { error: 'Codex capability synchronization is disabled', code: 'CODEX_SYNC_DISABLED' }); return true; }
        const state = req.method === 'POST' ? await refreshCodexCapabilitySync(providerId, { configDir: CONFIG_DIR, registry, expectedBinding: binding })
          : await readCodexCapabilitySync(CONFIG_DIR, binding, profile.id);
        if (req.method === 'POST' && !state) { writeJson(res, 409, { error: 'Codex account or synchronization policy changed during discovery', code: 'CODEX_SYNC_CHANGED' }); return true; }
        writeJson(res, 200, { sync: mode === 'disabled' ? null : state, mode });
        return true;
      }
      let enabled;
      let restartStatus = 'unknown';
      if (req.method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req, CODEX_MCP_BODY_MAX_BYTES)); }
        catch { writeJson(res, 400, { error: 'Invalid JSON body' }); return true; }
        if (typeof body?.enabled !== 'boolean') { writeJson(res, 400, { error: 'Invalid Plugin preference' }); return true; }
        // Recheck account ownership before mutating a preference after async I/O.
        const latestProfile = await registry.getProviderProfile(providerId);
        const latestAuth = latestProfile?.authProfileId ? await registry.getAuthProfile(latestProfile.authProfileId) : null;
        const latest = latestAuth?.storageRef ? await createSecretStore({ configDir: CONFIG_DIR }).resolveSecret(latestAuth.storageRef) : null;
        if (latestProfile?.agentType !== 'codex' || managedCodexMcpAccountBinding(latest) !== binding) {
          writeJson(res, 409, { error: 'Codex account changed', code: 'CODEX_PLUGIN_ACCOUNT_CHANGED' }); return true;
        }
        enabled = await writeCodexPluginPreference(CONFIG_DIR, binding, body.enabled);
        // A busy or older broker remains in service. Its setting is pending;
        // never interrupt a running task just to apply this preference.
        try {
          const accountId = nativeCodexAccountId(secret.tokens);
          const providerHomeRoot = nativeProviderHomeRoot(dirname(CODEX_MANAGED_HOME_DIR), 'codex', profile.id);
          const homeRoot = await resolveCodexAccountHomeRoot({ configDir: CONFIG_DIR, providerHomeRoot,
            providerProfileId: profile.id, accountId });
          restartStatus = await retireIdleCodexBrokerForPluginChange({ homeRoot, accountId });
        } catch { restartStatus = 'deferred'; }
      } else enabled = await readCodexPluginPreference(CONFIG_DIR, binding);
      writeJson(res, 200, { desiredEnabled: enabled, effectiveEnabled: null, scope: 'account', appliesOn: 'next-broker-restart', restartStatus });
    } catch { writeJson(res, 500, { error: 'Codex Plugin preference is unavailable' }); }
    return true;
  }
  const scopedMatch = /^\/api\/providers\/([^/]+)\/codex\/mcp-servers(?:\/([^/]+)(?:\/(oauth)(?:\/([a-f0-9]+))?)?)?$/.exec(pathname);
  if (scopedMatch) {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    if (WORKBENCH_EXECUTION_POLICY) {
      writeJson(res, 403, { error: 'MCP management is locked by the workbench operator', code: 'WORKBENCH_EXECUTION_POLICY_DENIED' });
      return true;
    }
    let providerId, serverName;
    try { providerId = decodeURIComponent(scopedMatch[1]); serverName = scopedMatch[2] ? decodeURIComponent(scopedMatch[2]) : ''; }
    catch { writeJson(res, 400, { error: 'Invalid provider or server id' }); return true; }
    if (serverName && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(serverName)) {
      writeJson(res, 400, { error: 'Invalid server id' });
      return true;
    }
    const registry = createNativeProviderRegistry({ configDir: CONFIG_DIR });
    const profile = await registry.getProviderProfile(providerId).catch(() => null);
    if (!profile || profile.agentType !== 'codex') {
      writeJson(res, 404, { error: 'Codex provider not found' });
      return true;
    }
    const auth = await registry.getAuthProfile(profile.authProfileId).catch(() => null);
    const secret = auth?.storageRef ? await createSecretStore({ configDir: CONFIG_DIR }).resolveSecret(auth.storageRef).catch(() => null) : null;
    const binding = managedCodexMcpAccountBinding(secret);
    if (!binding) {
      writeJson(res, 409, { error: 'The Codex account identity could not be verified', code: 'CODEX_MCP_ACCOUNT_UNVERIFIED' });
      return true;
    }
    const accountStillSelected = async () => {
      const latestProfile = await registry.getProviderProfile(providerId).catch(() => null);
      const latestAuth = latestProfile?.authProfileId
        ? await registry.getAuthProfile(latestProfile.authProfileId).catch(() => null) : null;
      const latestSecret = latestAuth?.storageRef
        ? await createSecretStore({ configDir: CONFIG_DIR }).resolveSecret(latestAuth.storageRef).catch(() => null) : null;
      return latestProfile?.agentType === 'codex' && managedCodexMcpAccountBinding(latestSecret) === binding;
    };
    if (scopedMatch[3]) {
      const accountId = secret.authType === 'oauth' ? nativeCodexAccountId(secret.tokens) : '';
      if (!accountId) {
        writeJson(res, 409, { error: 'MCP authorization requires a verified Codex account', code: 'CODEX_MCP_ACCOUNT_UNVERIFIED' });
        return true;
      }
      const providerHomeRoot = nativeProviderHomeRoot(dirname(CODEX_MANAGED_HOME_DIR), 'codex', profile.id);
      try {
        const homeRoot = await resolveCodexAccountHomeRoot({ configDir: CONFIG_DIR, providerHomeRoot,
          providerProfileId: profile.id, accountId });
        const codexHomeDir = join(homeRoot, 'codex');
        if (req.method === 'GET' && scopedMatch[4]) {
          const job = await readCodexMcpOAuth({ id: scopedMatch[4], providerId: profile.id, accountBinding: binding, accountId, codexHomeDir, name: serverName });
          if (!job) writeJson(res, 404, { error: 'Authorization request not found' });
          else writeJson(res, 200, job);
          return true;
        }
        if (req.method === 'DELETE' && scopedMatch[4]) {
          const job = cancelCodexMcpOAuth({ id: scopedMatch[4], providerId: profile.id, accountBinding: binding, name: serverName });
          if (!job) writeJson(res, 404, { error: 'Authorization request not found' });
          else writeJson(res, 200, job);
          return true;
        }
        if (req.method === 'POST' && scopedMatch[4]) {
          let payload;
          try { payload = JSON.parse(await readBody(req, CODEX_MCP_BODY_MAX_BYTES)); }
          catch { writeJson(res, 400, { error: 'Invalid callback' }); return true; }
          if (!await accountStillSelected()) { writeJson(res, 409, { error: 'Codex account changed', code: 'CODEX_MCP_ACCOUNT_CHANGED' }); return true; }
          try {
            const forwarded = await forwardCodexMcpOAuthCallback({ id: scopedMatch[4], providerId: profile.id,
              accountBinding: binding, name: serverName, callbackUrl: payload?.callbackUrl });
            if (!forwarded) writeJson(res, 404, { error: 'Authorization request not found' });
            else writeJson(res, 200, forwarded);
          } catch { writeJson(res, 400, { error: 'Callback is invalid, expired, or unsupported' }); }
          return true;
        }
        if (req.method === 'POST' && !scopedMatch[4]) {
          const configured = await withManagedCodexMcpLock(CONFIG_DIR, profile.id, binding, async (home) => {
            if (!await ensureManagedCodexMcpBinding(home, binding)) return false;
            const listed = await listCodexMcpServers({ codexHomeDir: home });
            return listed.ok && listed.servers.some((server) => server.name === serverName);
          });
          if (!configured) { writeJson(res, 404, { error: 'MCP server not found for this account' }); return true; }
          if (!await accountStillSelected()) { writeJson(res, 409, { error: 'Codex account changed', code: 'CODEX_MCP_ACCOUNT_CHANGED' }); return true; }
          const job = await beginCodexMcpOAuth({ providerId: profile.id, accountId, accountBinding: binding, codexHomeDir, name: serverName });
          writeJson(res, 200, job);
          return true;
        }
        writeJson(res, 405, { error: 'Unsupported method' });
      } catch {
        writeJson(res, 409, { error: 'Start a Codex task to prepare this account, then retry MCP authorization.', code: 'CODEX_MCP_BROKER_REQUIRED' });
      }
      return true;
    }
    let payload = null;
    if (req.method === 'POST' && !serverName) {
      try { payload = JSON.parse(await readBody(req, CODEX_MCP_BODY_MAX_BYTES)); }
      catch { writeJson(res, 400, { error: 'Invalid JSON body' }); return true; }
    }
    try {
      const result = await withManagedCodexMcpLock(CONFIG_DIR, profile.id, binding, async (codexHomeDir) => {
        if (!await accountStillSelected()) {
          return { ok: false, error: 'Codex account changed', code: 'CODEX_MCP_ACCOUNT_CHANGED' };
        }
        if (!await ensureManagedCodexMcpBinding(codexHomeDir, binding, { initialize: true })) {
          return { ok: false, error: 'MCP configuration belongs to a different or unverified account', code: 'CODEX_MCP_ACCOUNT_CHANGED' };
        }
        const options = { codexHomeDir, exactCommand: true };
        if (req.method === 'GET' && !serverName) {
          const listed = await listCodexMcpServers(options);
          if (!listed.ok) return listed;
          // Do not return environment values, headers, or bearer token names.
          return { ok: true, servers: listed.servers.map((server) => ({
            name: server.name, enabled: server.enabled, transport: { type: server.transport?.type },
          })) };
        }
        if (req.method === 'DELETE' && serverName) return removeCodexMcpServer({ name: serverName }, options);
        if (req.method === 'POST' && !serverName) {
          const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
          const command = typeof payload?.command === 'string' ? payload.command.trim() : '';
          const url = typeof payload?.url === 'string' ? payload.url.trim() : '';
          const args = payload?.args === undefined ? [] : payload.args;
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name) || !Array.isArray(args)
              || args.some((arg) => typeof arg !== 'string') || Boolean(command) === Boolean(url)
              || payload?.env !== undefined) return { ok: false, error: 'Invalid MCP configuration' };
          if (url) {
            let parsed;
            try { parsed = new URL(url); } catch { return { ok: false, error: 'Invalid MCP URL' }; }
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
              return { ok: false, error: 'MCP URL must not contain credentials, query parameters or fragments' };
            }
          }
          return addCodexMcpServer({ name, command, url, args }, options);
        }
        return { ok: false, error: 'Unsupported method' };
      }, { create: true });
      if (!result.ok) writeJson(res, result.code === 'CODEX_MCP_ACCOUNT_CHANGED' ? 409 : 400, { error: result.error, ...(result.code ? { code: result.code } : {}) });
      else writeJson(res, 200, { ...result, scope: 'account', providerProfileId: profile.id, appliesOn: 'next-runtime-refresh' });
    } catch {
      writeJson(res, 500, { error: 'Codex MCP configuration is unavailable' });
    }
    return true;
  }
  if (isCodexMcpListRoute(pathname) && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    const result = await listCodexMcpServers();
    if (!result.ok) {
      writeJson(res, 500, { error: result.error, servers: [] });
      return true;
    }
    writeJson(res, 200, { servers: result.servers });
    return true;
  }

  if (isCodexMcpListRoute(pathname) && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    let payload = {};
    try {
      const rawBody = await readBody(req, CODEX_MCP_BODY_MAX_BYTES);
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const result = await addCodexMcpServer({
      name: typeof payload.name === 'string' ? payload.name : '',
      command: typeof payload.command === 'string' ? payload.command : '',
      args: Array.isArray(payload.args) ? payload.args.map(String) : [],
      url: typeof payload.url === 'string' ? payload.url : '',
      env: payload.env && typeof payload.env === 'object' && !Array.isArray(payload.env) ? payload.env : {},
    });
    if (!result.ok) {
      writeJson(res, 400, { error: result.error });
      return true;
    }
    writeJson(res, 200, { ok: true });
    return true;
  }

  const serverName = parseCodexMcpServerDeleteRoute(pathname);
  if (serverName && req.method === 'DELETE') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    const result = await removeCodexMcpServer({ name: serverName });
    if (!result.ok) {
      writeJson(res, 400, { error: result.error });
      return true;
    }
    writeJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

import { StringDecoder } from 'node:string_decoder';
import { spawnManagedProviderProcess, terminateProviderProcessTree } from '../lib/windows-managed-spawn.mjs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlatformSpawnSpec, resolveExecutableCommandPathAsync } from '../lib/executable-resolution.mjs';
import { buildClaudeBidiInitializeMessage, readClaudeBidiControlResponse } from './claude-bidi-protocol.mjs';

const TIMEOUT_MS = 15000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const REQUEST_ID = 'ragent-model-discovery';

// Only the model fields leave this module. Initialize can also return account
// information, so neither the response nor stderr should ever be logged.
function modelsFromResponse(response) {
  const models = response?.response?.models;
  if (!Array.isArray(models)) return null;
  const seen = new Set();
  const result = [];
  for (const model of models) {
    if (!model || typeof model !== 'object') continue;
    const id = model.value == null || model.value === '' ? 'default' : (typeof model.value === 'string' ? model.value : '');
    if (!id || id.length > 200 || /[@\s\x00-\x1f\x7f]/.test(id) || seen.has(id)) continue;
    const label = typeof model.displayName === 'string' ? model.displayName.trim() : '';
    const resolvedModel = typeof model.resolvedModel === 'string' ? model.resolvedModel.trim() : '';
    seen.add(id);
    const capability = {};
    if (typeof model.description === 'string' && model.description.length <= 1000) capability.description = model.description;
    for (const key of ['supportsEffort', 'supportsAdaptiveThinking', 'supportsFastMode', 'supportsAutoMode']) {
      if (typeof model[key] === 'boolean') capability[key] = model[key];
    }
    for (const key of ['supportedEffortLevels', 'effortLevels']) {
      if (Array.isArray(model[key])) capability[key] = model[key].filter((v) => typeof v === 'string' && /^[a-z0-9_-]{1,32}$/i.test(v)).slice(0, 32);
    }
    for (const key of ['defaultEffort']) {
      if (typeof model[key] === 'string' && /^[a-z0-9_-]{1,32}$/i.test(model[key])) capability[key] = model[key];
    }
    result.push({ id, label: label && label.length <= 300 ? label : id,
      ...(resolvedModel && resolvedModel.length <= 200 ? { resolvedModel } : {}), ...capability });
  }
  return result.length ? result : null;
}

function isolatedEnvironment(dir, token) {
  const env = {};
  // PATH is needed by npm's CLI shim; never inherit provider credentials,
  // proxy endpoints, plugin settings or Node startup options.
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'ComSpec']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: dir,
    APPDATA: join(dir, 'appdata'), LOCALAPPDATA: join(dir, 'localappdata'),
    XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data'),
    XDG_CACHE_HOME: join(dir, 'cache'), TMP: dir, TEMP: dir, TMPDIR: dir,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
  });
  return env;
}

/** Discover models using only the managed CLI's initialize request.
 * Returns null on unavailable CLI, unsupported version, auth/network failure,
 * malformed output or timeout. Callers own cache and refresh policy.
 */
export async function discoverClaudeSetupTokenModels({ token } = {}) {
  if (typeof token !== 'string' || !token.trim()) return null;
  let dir;
  try {
    const executable = await resolveExecutableCommandPathAsync('claude');
    if (!executable) return null;
    const tempRoot = tmpdir();
    await mkdir(tempRoot, { recursive: true });
    dir = await mkdtemp(join(tempRoot, 'ragent-claude-models-'));
    const env = isolatedEnvironment(dir, token);
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--safe-mode', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', '', '--settings', '{"enabledPlugins":{}}'];
    const spec = buildPlatformSpawnSpec(executable, args, { cwd: dir, env });
    const child = await spawnManagedProviderProcess(spec, {
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    return await new Promise((resolve) => {
      let finished = false;
      let output = '';
      let bytes = 0;
      const decoder = new StringDecoder('utf8');
      const finish = (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { child.stdin.destroy(); } catch {}
        try { terminateProviderProcessTree(child, 'SIGKILL'); } catch {}
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), TIMEOUT_MS);
      child.on('error', () => finish(null));
      child.on('exit', () => finish(null));
      child.stdin.on('error', () => finish(null));
      child.stderr.on('error', () => finish(null));
      child.stdout.on('error', () => finish(null));
      child.stderr.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) finish(null);
      });
      child.stdout.on('data', (chunk) => {
        try {
          bytes += chunk.length;
          if (bytes > MAX_OUTPUT_BYTES) return finish(null);
          output += decoder.write(chunk);
          let newline;
          while ((newline = output.indexOf('\n')) !== -1) {
            const line = output.slice(0, newline);
            output = output.slice(newline + 1);
            let message;
            try { message = JSON.parse(line); } catch { continue; }
            const control = readClaudeBidiControlResponse(message);
            if (control?.requestId === REQUEST_ID) {
              return finish(control.success ? modelsFromResponse(control.response) : null);
            }
          }
        } catch { finish(null); }
      });
      try { child.stdin.write(`${JSON.stringify(buildClaudeBidiInitializeMessage(REQUEST_ID))}\n`); }
      catch { finish(null); }
    });
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

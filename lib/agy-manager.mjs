// AgentoC AgY Provider Manager
// Handles AgY CLI execution, credential management, and integration

import { existsSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveExecutableCommandPathAsync } from './executable-resolution.mjs';
import { spawnManagedProviderProcess, terminateProviderProcessTree } from './windows-managed-spawn.mjs';
import {
  buildAgyStreamInput,
  buildAgyRuntimeEnv,
  buildAgyRuntimeLaunchSpec,
} from './agy-runtime.mjs';
import { CONFIG_DIR } from './config.mjs';
import { createNativeProviderRegistry } from './provider-runtime/registry.mjs';
import { createSecretStore } from './provider-runtime/secret-store.mjs';
import { prepareNativeRunProviderHome } from './provider-runtime/run-provider-prepare.mjs';

export const AGY_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high']);
export const DEFAULT_AGY_PRINT_TIMEOUT = '24h';
export const DEFAULT_AGY_PROCESS_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_AGY_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const AGY_EFFORT_SUFFIX = /^(.*?)[-_](low|medium|high)$/i;
const AGY_EFFORT_LABEL_SUFFIX = /\s*(?:\((?:low|medium|high|thinking)\)|[-–—:]?\s*(?:low|medium|high|thinking))\s*$/i;

export function normalizeAgyModelCatalog(entries) {
  const parsed = [];
  const variantGroups = new Map();

  for (const entry of Array.isArray(entries) ? entries : []) {
    const rawId = String(entry?.id || entry || '').trim();
    if (!rawId) continue;
    const rawLabel = String(entry?.label || rawId).trim() || rawId;
    const suffixMatch = rawId.match(AGY_EFFORT_SUFFIX);
    const variantLevel = suffixMatch?.[2]?.toLowerCase() || '';
    const variantBaseId = suffixMatch?.[1]?.trim() || '';
    const parsedEntry = { rawId, rawLabel, variantLevel, variantBaseId };
    parsed.push(parsedEntry);
    if (variantBaseId && variantLevel) {
      if (!variantGroups.has(variantBaseId)) variantGroups.set(variantBaseId, new Map());
      variantGroups.get(variantBaseId).set(variantLevel, parsedEntry);
    }
  }

  // Gemini exposes speed variants as separate ids, but accepts the grouped
  // base id with --effort. Only collapse a family when multiple levels are
  // present; a lone `-medium` model such as GPT-OSS is a fixed model id.
  const groupedBases = new Set(
    [...variantGroups.entries()]
      .filter(([, variants]) => variants.size > 1)
      .map(([baseId]) => baseId),
  );
  const models = [];
  const seen = new Set();
  for (const entry of parsed) {
    const isGrouped = entry.variantBaseId && groupedBases.has(entry.variantBaseId);
    const id = isGrouped ? entry.variantBaseId : entry.rawId;
    if (seen.has(id)) continue;
    seen.add(id);

    if (isGrouped) {
      const variants = variantGroups.get(entry.variantBaseId);
      const levels = AGY_EFFORT_LEVELS.filter((level) => variants.has(level));
      const label = entry.rawLabel.replace(AGY_EFFORT_LABEL_SUFFIX, '').trim() || id;
      models.push({
        id,
        label,
        reasoning: {
          kind: 'enum',
          label: 'Thinking',
          levels,
          default: levels.includes('medium') ? 'medium' : levels[0],
        },
      });
      continue;
    }

    // Fixed ids such as claude-opus-4-6-thinking and gpt-oss-120b-medium do
    // not imply that the CLI accepts a separate --effort flag.
    models.push({
      id,
      label: entry.rawLabel,
      reasoning: { kind: 'none', label: 'Thinking' },
    });
  }
  return models;
}

async function resolveAgyPath() {
  const resolved = await resolveExecutableCommandPathAsync('agy').catch(() => null);
  if (resolved && existsSync(resolved)) {
    return resolved;
  }
  throw new Error('Internal AgY CLI is not installed. Install it in Ragent Harness management.');
}

export async function executeAgyCommand(args, options = {}) {
  const agyPath = await resolveAgyPath();
  const managedHome = await resolveAgyCommandHome(options);
  const env = await buildAgyRuntimeEnv({
    ...process.env,
    ...(options.env || {}),
  }, {
    homeDir: managedHome.homeDir,
    control: false,
  });
  const spawnSpec = buildAgyRuntimeLaunchSpec({
    command: agyPath,
    args,
    env,
    cwd: options.cwd || globalThis.process.cwd(),
  });

  let child;
  try {
    child = await spawnManagedProviderProcess(spawnSpec, {
      stdio: options.stdio || 'pipe',
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });
  } catch (error) {
    await managedHome.cleanup();
    throw error;
  }

  const timeoutMs = Number.isFinite(Number(options.timeout))
    ? Math.max(1_000, Math.min(DEFAULT_AGY_PROCESS_TIMEOUT_MS, Number(options.timeout)))
    : DEFAULT_AGY_PROCESS_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let outputTruncated = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timer = null;
    let killTimer = null;

    const appendBounded = (current, chunk, stream) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''));
      const bytes = stream === 'stdout' ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, MAX_AGY_COMMAND_OUTPUT_BYTES - bytes);
      if (buffer.byteLength > remaining) outputTruncated = true;
      const retained = buffer.subarray(0, remaining).toString('utf8');
      if (stream === 'stdout') stdoutBytes += Buffer.byteLength(retained, 'utf8');
      else stderrBytes += Buffer.byteLength(retained, 'utf8');
      return `${current}${retained}`;
    };
    const finish = async (callback) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      await managedHome.cleanup().catch(() => {});
      callback();
    };
    const terminateAndBound = () => {
      terminateProviderProcessTree(child, 'SIGTERM');
      if (killTimer) return;
      killTimer = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) {
          terminateProviderProcessTree(child, 'SIGKILL');
        }
        if (!settled) {
          void finish(() => reject(new Error(
            timedOut
              ? `AgY command timed out after ${timeoutMs}ms`
              : `AgY command output exceeded ${MAX_AGY_COMMAND_OUTPUT_BYTES} bytes`,
          )));
        }
      }, 2_000);
      killTimer.unref?.();
    };

    child.stdout?.on('data', (data) => {
      stdout = appendBounded(stdout, data, 'stdout');
      if (outputTruncated && !settled) terminateAndBound();
    });
    child.stderr?.on('data', (data) => {
      stderr = appendBounded(stderr, data, 'stderr');
      if (outputTruncated && !settled) terminateAndBound();
    });
    child.stdin?.on?.('error', () => {});

    child.on('close', (code) => {
      if (code === 0 && !timedOut && !outputTruncated) {
        void finish(() => resolve({ stdout, stderr, exitCode: code }));
      } else {
        const reason = timedOut
          ? `AgY command timed out after ${timeoutMs}ms`
          : outputTruncated
            ? `AgY command output exceeded ${MAX_AGY_COMMAND_OUTPUT_BYTES} bytes`
            : `AgY command failed with exit code ${code}: ${stderr}`;
        void finish(() => reject(new Error(reason)));
      }
    });

    child.on('error', (error) => {
      void finish(() => reject(new Error(`Failed to execute AgY: ${error.message}`)));
    });

    timer = setTimeout(() => {
      timedOut = true;
      terminateAndBound();
    }, timeoutMs);
    timer.unref?.();

    if (options.input && child.stdin?.writable) {
      try { child.stdin.write(options.input); } catch {}
    }
    // The real CLI waits for stdin EOF in non-interactive mode. Always close
    // the pipe unless a caller explicitly asks for an interactive stdio mode.
    if (child.stdin && options.stdio === undefined) {
      try { child.stdin.end(); } catch {}
    }
  });
}

async function resolveAgyCommandHome(options = {}) {
  const explicit = typeof options.agyHomeDir === 'string' ? options.agyHomeDir.trim() : '';
  if (explicit) return { homeDir: explicit, cleanup: async () => {} };

  // Version checks and availability probes do not need an account, but still
  // need a private HOME so they cannot touch the terminal or legacy control
  // account.  All account-bearing commands must resolve a registry profile.
  if (options.allowUnconfiguredHome === true) {
    const homeDir = await mkdtemp(join(tmpdir(), 'agentoc-agy-command-'));
    return {
      homeDir,
      cleanup: async () => { await rm(homeDir, { recursive: true, force: true }).catch(() => {}); },
    };
  }

  const registry = createNativeProviderRegistry({ configDir: CONFIG_DIR });
  const secretStore = createSecretStore({ configDir: CONFIG_DIR });
  const providerProfile = typeof options.providerProfile === 'string'
    ? options.providerProfile.trim()
    : '';
  const prepared = await prepareNativeRunProviderHome(`direct-${randomUUID()}`, {
    tool: 'agy',
    runtimeFamily: 'agy-json',
    options: {
      runtimeFamily: 'agy-json',
      ...(providerProfile ? { providerProfile } : {}),
      ...(typeof options.model === 'string' && options.model.trim() ? { model: options.model.trim() } : {}),
    },
  }, {
    configDir: CONFIG_DIR,
    providerHomesRoot: join(CONFIG_DIR, 'provider-runtime-homes', 'direct'),
    externalOAuthOwnership: false,
    registry,
    secretStore,
  });
  if (!prepared?.ok || !prepared.agyHomeDir) {
    throw new Error(prepared?.error || 'No AgY provider account is configured');
  }
  return {
    homeDir: prepared.agyHomeDir,
    cleanup: async () => { await rm(prepared.homeDir, { recursive: true, force: true }).catch(() => {}); },
  };
}

export async function listAgyModels(options = {}) {
  try {
    const result = await executeAgyCommand(['models'], {
      timeout: 30000,
      ...(options.agyHomeDir ? { agyHomeDir: options.agyHomeDir } : {}),
    });
    return normalizeAgyModelCatalog(parseModelsOutput(result.stdout));
  } catch (error) {
    console.error('Failed to list AgY models:', error.message);
    return [];
  }
}

export async function listAgyAgents() {
  try {
    const result = await executeAgyCommand(['agents'], { timeout: 30000 });
    return parseAgentsOutput(result.stdout);
  } catch (error) {
    console.error('Failed to list AgY agents:', error.message);
    return [];
  }
}

export async function executeAgyPrompt(prompt, options = {}) {
  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--print=',
  ];

  if (options.model) args.push('--model', options.model);
  if (options.agent) args.push('--agent', options.agent);
  if (options.project) args.push('--project', options.project);
  if (options.mode) args.push('--mode', options.mode);
  args.push('--print-timeout', String(options.printTimeout || DEFAULT_AGY_PRINT_TIMEOUT));

  try {
    const result = await executeAgyCommand(args, {
      timeout: options.timeout || DEFAULT_AGY_PROCESS_TIMEOUT_MS,
      input: buildAgyStreamInput(prompt),
    });
    return parseAgyOutput(result.stdout, options.format);
  } catch (error) {
    throw new Error(`AgY execution failed: ${error.message}`);
  }
}

export async function executeAgyInteractive(prompt, options = {}) {
  const args = ['--prompt-interactive', prompt];

  if (options.model) args.push('--model', options.model);
  if (options.agent) args.push('--agent', options.agent);
  if (options.project) args.push('--project', options.project);
  if (options.mode) args.push('--mode', options.mode);
  if (options.sandbox) args.push('--sandbox');

  try {
    return await executeAgyCommand(args, {
      timeout: options.timeout || DEFAULT_AGY_PROCESS_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(`AgY interactive execution failed: ${error.message}`);
  }
}

// Helper functions to parse AgY output
function parseModelsOutput(output) {
  const models = [];
  const lines = output.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('Fetching')) continue;
    const [id, label] = trimmed.split(/\t+/, 2);
    if (id && label) {
      models.push({ id: id.trim(), label: label.trim() });
    } else if (id) {
      models.push({ id: id.trim(), label: id.trim() });
    }
  }

  return models;
}

function parseAgentsOutput(output) {
  const agents = [];
  const lines = output.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('Fetching')) {
      agents.push(trimmed);
    }
  }

  return agents;
}

function parseAgyOutput(output, format) {
  const events = output.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { raw: line };
    }
  });
  if (format === 'stream-json') return events;

  const result = events.find((event) => event?.event === 'result')?.result;
  if (format === 'json') return result || { text: output.trim() };
  return { text: typeof result?.response === 'string' ? result.response.trim() : output.trim() };
}

export async function getAgyVersion() {
  try {
    const result = await executeAgyCommand(['--version'], { timeout: 10000, allowUnconfiguredHome: true });
    const match = `${result.stdout}\n${result.stderr}`.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function ensureAgyAvailable() {
  try {
    await resolveAgyPath();
    return true;
  } catch (error) {
    console.error('AgY CLI is not available:', error.message);
    return false;
  }
}

export { resolveAgyPath };

import { readFile } from 'fs/promises';
import { join } from 'path';

import { createClaudeAdapter, buildClaudeArgs } from './adapters/claude.mjs';
import { createClaudeBidiAdapter, buildClaudeBidiArgs, CLAUDE_BIDI_RUNTIME_FAMILY } from './adapters/claude-bidi.mjs';
import { createCodexAdapter, buildCodexArgs } from './adapters/codex.mjs';
import { readPreferredCodexModelFromConfig } from './models.mjs';
import {
  CODEX_APP_SERVER_RUNTIME_FAMILY,
  buildCodexAppServerArgs,
  createCodexAppServerAdapter,
  isCodexAppServerRuntimeFamily,
} from './adapters/codex-app-server.mjs';
import { createCopilotAdapter, buildCopilotArgs } from './adapters/copilot.mjs';
import { createPiAdapter, buildPiArgs, buildPiInput, PI_RUNTIME_FAMILY } from './adapters/pi.mjs';
import { createDeepSeekHarnessAdapter, buildDeepSeekHarnessArgs, buildDeepSeekHarnessAcpArgs, DEEPSEEK_HARNESS_RUNTIME_FAMILY } from './adapters/deepseek-harness.mjs';
import { buildAcpStartInput } from './adapters/acp-stdio.mjs';
import { createQwenCodeAdapter, buildQwenCodeArgs, QWEN_CODE_RUNTIME_FAMILY } from './adapters/qwen-code.mjs';
import { createOpenCodeAdapter, buildOpenCodeArgs, OPENCODE_RUNTIME_FAMILY } from './adapters/opencode.mjs';
import { createKimiCodeAdapter, buildKimiCodeArgs, KIMI_CODE_RUNTIME_FAMILY } from './adapters/kimi-code.mjs';
import { createGooseAdapter, buildGooseArgs, GOOSE_RUNTIME_FAMILY } from './adapters/goose.mjs';
import { createOpenHandsAdapter, buildOpenHandsArgs, OPENHANDS_RUNTIME_FAMILY } from './adapters/openhands.mjs';
import { createHermesAdapter, buildHermesAcpArgs, HERMES_RUNTIME_FAMILY } from './adapters/hermes.mjs';
import { createClineAdapter, buildClineArgs, CLINE_RUNTIME_FAMILY } from './adapters/cline.mjs';
import { createKiloAdapter, buildKiloArgs, KILO_RUNTIME_FAMILY } from './adapters/kilo.mjs';
import {
  AGY_RUNTIME_FAMILY,
  AGY_STREAM_RUNTIME_FAMILY,
  DEFAULT_AGY_PRINT_TIMEOUT,
  createAgyAdapter,
  createAgyStreamAdapter,
  buildAgyArgs,
} from './adapters/agy.mjs';
import { expandSessionFolder } from './session-folder.mjs';
import {
  buildToolProcessEnvOverrides,
  getToolDefinitionAsync,
  getToolCommandAsync,
  resolveToolCommandPathAsync,
} from '../lib/tools.mjs';
import {
  formatAttachmentContextReference,
  getAttachmentDisplayName,
  getAttachmentExecutionPath,
} from './attachment-utils.mjs';
import { pathExists } from './fs-utils.mjs';
import { internalHarnessId } from '../lib/harness-paths.mjs';
import {
  buildProviderContractFields,
  getGatedPermissionModeId,
  requiresExplicitAcpAutoMode,
  resolveProviderPermissionPolicy,
} from './provider-contract.mjs';
import { statusEvent } from './normalizer.mjs';
import { CLAUDE_MANAGED_HOME_DIR } from '../lib/config.mjs';
import { buildAgyStreamInput } from '../lib/agy-runtime.mjs';
import { buildPlatformSpawnSpec } from '../lib/executable-resolution.mjs';

export function resolveCwd(folder) {
  return expandSessionFolder(folder);
}

const TAG = '[process-runner]';
const CLAUDE_RUNTIME_FAMILIES = new Set([
  'claude-stream-json',
  CLAUDE_BIDI_RUNTIME_FAMILY,
]);
const CLAUDE_MODEL_ALIAS_ENV_KEYS = {
  default: [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ],
  opus: ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_MODEL'],
  sonnet: ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_MODEL'],
  haiku: ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_MODEL'],
  fable: ['ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_MODEL'],
};
const AGY_RUNTIME_FAMILIES = new Set([AGY_RUNTIME_FAMILY, AGY_STREAM_RUNTIME_FAMILY]);

function isClaudeRuntimeFamily(runtimeFamily) {
  return CLAUDE_RUNTIME_FAMILIES.has(String(runtimeFamily || '').trim());
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function bareScopedModel(value) {
  const model = cleanString(value);
  const at = model.lastIndexOf('@');
  if (at <= 0 || at === model.length - 1) return model;
  return /^[A-Za-z0-9._-]+$/.test(model.slice(at + 1)) ? model.slice(0, at) : model;
}

// Every harness is consumed by the same detached reader. A provider-specific
// parser exception must become a visible run failure event, never an uncaught
// readline callback exception that tears down app-server and leaves the Run
// looking idle. Keep this guard at the common factory boundary so all current
// and future runtime families receive identical failure semantics.
export function guardHarnessAdapter(adapter, runtimeFamily = '') {
  if (!adapter || typeof adapter.parseLine !== 'function') {
    throw new Error(`Harness adapter for ${runtimeFamily || 'unknown'} lacks parseLine()`);
  }
  const parseLine = adapter.parseLine.bind(adapter);
  const flush = typeof adapter.flush === 'function' ? adapter.flush.bind(adapter) : () => [];
  const adapterError = (error) => [statusEvent(
    `adapter error: ${error?.message || String(error)}`,
    {
      provider: adapter.provider || null,
      runtimeFamily,
      adapterError: true,
      runState: 'failed',
    },
  )];
  return {
    ...adapter,
    parseLine(line) {
      try {
        const events = parseLine(line);
        if (!Array.isArray(events)) throw new Error('parseLine() must return an array');
        return events;
      } catch (error) {
        console.error(`[process-runner] ${runtimeFamily} adapter parse failed: ${error?.message || error}`);
        return adapterError(error);
      }
    },
    flush(...args) {
      try {
        const events = flush(...args);
        if (!Array.isArray(events)) throw new Error('flush() must return an array');
        return events;
      } catch (error) {
        console.error(`[process-runner] ${runtimeFamily} adapter flush failed: ${error?.message || error}`);
        return adapterError(error);
      }
    },
  };
}

async function readManagedClaudeSettingsEnv({ claudeHomeDir = CLAUDE_MANAGED_HOME_DIR } = {}) {
  try {
    const text = await readFile(join(claudeHomeDir, 'settings.json'), 'utf8');
    const parsed = JSON.parse(text);
    return parsed?.env && typeof parsed.env === 'object' ? parsed.env : {};
  } catch {
    return {};
  }
}

export async function resolveClaudeRuntimeModelAlias(model, options = {}) {
  // Native-mode catalogs scope model ids per provider (`sonnet@newapi-zai-glm`).
  // The suffix picks the provider home at launch; the CLI only wants the bare
  // tier alias, so strip it before alias resolution.
  const scoped = cleanString(model);
  const at = scoped.lastIndexOf('@');
  const requested = at > 0 && /^[A-Za-z0-9._-]+$/.test(scoped.slice(at + 1))
    ? scoped.slice(0, at)
    : scoped;
  // When no model is specified, resolve from ANTHROPIC_MODEL so the managed
  // env block serves as the single source of truth.  Without this fallback,
  // an empty model causes no --model flag to be passed, and Claude Code
  // falls back to settings.json's top-level "model" key — which may be
  // a different model than what the env block configures, producing cryptic
  // provider errors like "glm-5.1 is not supported by DeepSeek".
  if (!requested) {
    const env = await readManagedClaudeSettingsEnv(options);
    return cleanString(env.ANTHROPIC_MODEL);
  }
  const keys = CLAUDE_MODEL_ALIAS_ENV_KEYS[requested.toLowerCase()];
  if (!keys) return requested;
  const env = await readManagedClaudeSettingsEnv(options);
  for (const key of keys) {
    const value = cleanString(env[key]);
    if (value) return value;
  }
  return requested;
}

/**
 * Resolve a command name to its full absolute path.
 */
export async function resolveCommand(cmd) {
  const resolved = await resolveToolCommandPathAsync(cmd);
  if (resolved && await pathExists(resolved)) {
    console.log(`${TAG} Resolved "${cmd}" → ${resolved}`);
    return resolved;
  }
  if (internalHarnessId(cmd)) {
    const error = new Error(`Internal Harness is not installed: ${cmd}. Install it in Ragent Harness management.`);
    error.code = 'HARNESS_RUNTIME_UNAVAILABLE';
    throw error;
  }
  console.log(`${TAG} Could not resolve "${cmd}", using bare name`);
  return cmd;
}

export async function resolveCommandSpawnSpec(cmd, args = [], options = {}) {
  const resolved = await resolveCommand(cmd);
  return buildPlatformSpawnSpec(resolved, args, options);
}

export function buildRuntimeInvocation(runtimeFamily, prompt, options = {}, toolId = 'unknown') {
  const normalizedRuntimeFamily = typeof runtimeFamily === 'string' ? runtimeFamily.trim() : '';
  if (!normalizedRuntimeFamily) {
    throw new Error(`Tool "${toolId}" is missing runtimeFamily`);
  }
  const permissionPolicy = resolveProviderPermissionPolicy(normalizedRuntimeFamily, {
    permissionMode: options.permissionMode,
    interactionMode: options.interactionMode,
    riskMode: options.riskMode,
    ...((normalizedRuntimeFamily === 'claude-stream-json'
      || normalizedRuntimeFamily === CLAUDE_BIDI_RUNTIME_FAMILY)
      ? { dangerouslySkipPermissions: options.dangerouslySkipPermissions === true }
      : {}),
  });
  const riskMode = typeof options.riskMode === 'string' ? options.riskMode.trim() : '';
  if (riskMode === 'full-auto' && normalizedRuntimeFamily === 'claude-stream-json') {
    const error = new Error('The claude-stream-json Harness cannot return permission decisions to Ragent');
    error.code = 'PERMISSION_PROFILE_UNSUPPORTED_RUNTIME';
    error.statusCode = 409;
    throw error;
  }
  if ((riskMode === 'safe' || riskMode === 'recommended')
      && !getGatedPermissionModeId(normalizedRuntimeFamily)) {
    const error = new Error(`The ${normalizedRuntimeFamily} Harness cannot return permission decisions to Ragent`);
    error.code = 'PRIVILEGED_GATE_UNSUPPORTED_RUNTIME';
    error.statusCode = 409;
    throw error;
  }
  if ((riskMode === 'conservative-auto'
      || (riskMode === 'full-auto' && (process.platform === 'win32' || requiresExplicitAcpAutoMode(normalizedRuntimeFamily))))
      && !permissionPolicy) {
    const error = new Error(`The ${normalizedRuntimeFamily} Harness cannot enforce ${riskMode} permissions`);
    error.code = 'PERMISSION_PROFILE_UNSUPPORTED_RUNTIME';
    error.statusCode = 409;
    throw error;
  }
  const allowDangerousPermissionSkip = String(process.env.IS_SANDBOX || '').trim() === '1'
    && permissionPolicy?.dangerouslySkipPermissions === true;
  const claudePermissionMode = typeof permissionPolicy?.claudePermissionMode === 'string'
    ? permissionPolicy.claudePermissionMode
    : (typeof permissionPolicy?.id === 'string' ? permissionPolicy.id : '');
  let adapter;
  let args;
  const effectiveServiceTier = typeof process.env.AGENTOC_CODEX_SERVICE_TIER === 'string'
    && process.env.AGENTOC_CODEX_SERVICE_TIER.trim()
    ? process.env.AGENTOC_CODEX_SERVICE_TIER.trim()
    : options.serviceTier;

  if (normalizedRuntimeFamily === 'claude-stream-json') {
    adapter = createClaudeAdapter();
    args = buildClaudeArgs(prompt, {
      permissionMode: claudePermissionMode,
      dangerouslySkipPermissions: !claudePermissionMode && allowDangerousPermissionSkip,
      resume: options.claudeSessionId,
      maxTurns: options.maxTurns,
      continue: options.continue,
      allowedTools: options.allowedTools,
      mcpConfigPath: options.mcpConfigPath,
      thinking: options.thinking,
      model: options.model,
      effort: options.effort,
    });
  } else if (normalizedRuntimeFamily === CLAUDE_BIDI_RUNTIME_FAMILY) {
    adapter = createClaudeBidiAdapter();
    args = buildClaudeBidiArgs({
      permissionMode: claudePermissionMode,
      dangerouslySkipPermissions: !claudePermissionMode && allowDangerousPermissionSkip,
      forceClaudeCommandGate: ['recommended', 'full-auto'].includes(riskMode) && claudePermissionMode === 'default' && options.interactionMode !== 'plan',
      resume: options.claudeSessionId,
      maxTurns: options.maxTurns,
      continue: options.continue,
      allowedTools: options.allowedTools,
      mcpConfigPath: options.mcpConfigPath,
      thinking: options.thinking,
      model: options.model,
      effort: options.effort,
    });
  } else if (normalizedRuntimeFamily === 'codex-json') {
    adapter = createCodexAdapter();
    args = buildCodexArgs(prompt, {
      threadId: options.codexThreadId,
      useResume: options.codexResume === true,
      model: bareScopedModel(options.model),
      reasoningEffort: options.effort,
      serviceTier: effectiveServiceTier,
      developerInstructions: options.developerInstructions,
      interactionMode: options.interactionMode,
      permissionMode: permissionPolicy?.id || options.permissionMode,
      systemPrefix: options.systemPrefix,
    });
  } else if (isCodexAppServerRuntimeFamily(normalizedRuntimeFamily)) {
    adapter = createCodexAppServerAdapter();
    args = buildCodexAppServerArgs();
    if (effectiveServiceTier === 'fast') {
      args.push('-c', 'service_tier="fast"');
    } else if (effectiveServiceTier === 'standard') {
      args.push('-c', 'service_tier="default"');
    }
  } else if (normalizedRuntimeFamily === 'copilot-json') {
    adapter = createCopilotAdapter();
    args = buildCopilotArgs(prompt, {
      threadId: options.providerResumeId || options.codexThreadId,
      useResume: options.providerResume === true
        || options.codexResume === true
        || Boolean(options.providerResumeId),
      model: options.model,
      reasoningEffort: options.effort,
      developerInstructions: options.developerInstructions,
      interactionMode: options.interactionMode,
      systemPrefix: options.systemPrefix,
    });
  } else if (normalizedRuntimeFamily === PI_RUNTIME_FAMILY) {
    adapter = createPiAdapter();
    args = buildPiArgs({
      provider: options.piProvider || (process.env.AGENTOC_PROVIDER_PROTOCOL === 'anthropic-messages' ? 'anthropic' : 'openai'),
      model: options.model,
      sessionDir: options.piSessionDir,
      noSession: options.piNoSession,
    });
  } else if (normalizedRuntimeFamily === DEEPSEEK_HARNESS_RUNTIME_FAMILY) {
    adapter = createDeepSeekHarnessAdapter();
    args = options.deepSeekHarnessAcp === true
      ? buildDeepSeekHarnessAcpArgs({ configPath: options.deepSeekHarnessConfig })
      : buildDeepSeekHarnessArgs(prompt, { profile: options.deepSeekHarnessProfile || 'headless' });
  } else if (normalizedRuntimeFamily === QWEN_CODE_RUNTIME_FAMILY) {
    adapter = createQwenCodeAdapter();
    args = buildQwenCodeArgs(prompt, { model: options.model, riskMode: options.riskMode });
  } else if (normalizedRuntimeFamily === OPENCODE_RUNTIME_FAMILY) {
    adapter = createOpenCodeAdapter();
    args = buildOpenCodeArgs(prompt, { model: options.model, riskMode: options.riskMode });
  } else if (normalizedRuntimeFamily === KIMI_CODE_RUNTIME_FAMILY) {
    adapter = createKimiCodeAdapter();
    args = buildKimiCodeArgs(prompt);
  } else if (normalizedRuntimeFamily === GOOSE_RUNTIME_FAMILY) {
    adapter = createGooseAdapter();
    args = buildGooseArgs(prompt, { model: options.model });
  } else if (normalizedRuntimeFamily === OPENHANDS_RUNTIME_FAMILY) {
    adapter = createOpenHandsAdapter();
    args = buildOpenHandsArgs(prompt);
  } else if (normalizedRuntimeFamily === HERMES_RUNTIME_FAMILY) {
    adapter = createHermesAdapter();
    args = buildHermesAcpArgs();
  } else if (normalizedRuntimeFamily === CLINE_RUNTIME_FAMILY) {
    adapter = createClineAdapter();
    args = buildClineArgs(prompt, {
      provider: options.clineProvider,
      model: options.model,
      resume: options.providerResumeId,
      riskMode: options.riskMode,
    });
  } else if (normalizedRuntimeFamily === KILO_RUNTIME_FAMILY) {
    adapter = createKiloAdapter();
    args = buildKiloArgs(prompt, {
      model: options.model,
      resume: options.providerResumeId,
      riskMode: options.riskMode,
    });
  } else if (AGY_RUNTIME_FAMILIES.has(normalizedRuntimeFamily)) {
    adapter = normalizedRuntimeFamily === AGY_STREAM_RUNTIME_FAMILY
      ? createAgyStreamAdapter()
      : createAgyAdapter();
    args = buildAgyArgs(prompt, {
      // The catalog scopes identical model ids as model@agy-provider.  The
      // provider suffix is consumed by run preparation and must never reach
      // the AgY CLI's --model flag.
      model: bareScopedModel(options.model),
      effort: options.effort,
      printTimeout: options.printTimeout || DEFAULT_AGY_PRINT_TIMEOUT,
      mode: options.interactionMode === 'plan' ? 'plan' : 'accept-edits',
      conversationId: options.agyConversationId || options.providerResumeId,
      useResume: options.agyResume === true,
    });
  } else {
    throw new Error(`Tool "${toolId}" uses unsupported runtimeFamily "${normalizedRuntimeFamily}"`);
  }

  adapter = guardHarnessAdapter(adapter, normalizedRuntimeFamily);
  const providerContract = buildProviderContractFields(normalizedRuntimeFamily, {
    providerCapabilities: adapter?.capabilities || null,
  });

  return {
    adapter,
    adapterCompatibility: adapter?.adapterCompatibility || null,
    args,
    capabilities: providerContract.providerCapabilities || null,
    permissionMode: permissionPolicy?.id || null,
    permissionPolicy: permissionPolicy || null,
    provider: providerContract.provider || null,
    isClaudeFamily: normalizedRuntimeFamily === 'claude-stream-json'
      || normalizedRuntimeFamily === CLAUDE_BIDI_RUNTIME_FAMILY,
    isClaudeBidiFamily: normalizedRuntimeFamily === CLAUDE_BIDI_RUNTIME_FAMILY,
    isCodexFamily: normalizedRuntimeFamily === 'codex-json'
      || normalizedRuntimeFamily === CODEX_APP_SERVER_RUNTIME_FAMILY,
    isCodexAppServerFamily: normalizedRuntimeFamily === CODEX_APP_SERVER_RUNTIME_FAMILY,
    isAgyFamily: AGY_RUNTIME_FAMILIES.has(normalizedRuntimeFamily),
    isPiFamily: normalizedRuntimeFamily === PI_RUNTIME_FAMILY,
    isDeepSeekHarnessFamily: normalizedRuntimeFamily === DEEPSEEK_HARNESS_RUNTIME_FAMILY,
    isQwenCodeFamily: normalizedRuntimeFamily === QWEN_CODE_RUNTIME_FAMILY,
    isOpenCodeFamily: normalizedRuntimeFamily === OPENCODE_RUNTIME_FAMILY,
    isKimiCodeFamily: normalizedRuntimeFamily === KIMI_CODE_RUNTIME_FAMILY,
    isGooseFamily: normalizedRuntimeFamily === GOOSE_RUNTIME_FAMILY,
    isOpenHandsFamily: normalizedRuntimeFamily === OPENHANDS_RUNTIME_FAMILY,
    isHermesFamily: normalizedRuntimeFamily === HERMES_RUNTIME_FAMILY,
    isClineFamily: normalizedRuntimeFamily === CLINE_RUNTIME_FAMILY,
    isKiloFamily: normalizedRuntimeFamily === KILO_RUNTIME_FAMILY,
    runtimeFamily: providerContract.runtimeFamily || normalizedRuntimeFamily,
    ...(normalizedRuntimeFamily === 'claude-stream-json' ? { input: String(prompt || '') } : {}),
    ...(AGY_RUNTIME_FAMILIES.has(normalizedRuntimeFamily) ? { input: buildAgyStreamInput(prompt) } : {}),
    ...(normalizedRuntimeFamily === PI_RUNTIME_FAMILY ? { input: buildPiInput(prompt) } : {}),
    ...((normalizedRuntimeFamily === QWEN_CODE_RUNTIME_FAMILY
      || normalizedRuntimeFamily === KIMI_CODE_RUNTIME_FAMILY
      || normalizedRuntimeFamily === HERMES_RUNTIME_FAMILY
      || (normalizedRuntimeFamily === DEEPSEEK_HARNESS_RUNTIME_FAMILY && options.deepSeekHarnessAcp === true))
      ? { acp: true } : {}),
  };
}

export async function createToolInvocation(toolId, prompt, options = {}) {
  const tool = await getToolDefinitionAsync(toolId);
  // The control plane resolves the tool definition (its config dir may differ
  // from the runner's — the hardened runner env never inherits
  // AGENTOC_CONFIG_DIR/HOME), so it can hand the resolved command through the
  // run manifest.  Prefer the local registry first; the manifest override
  // only kicks in for tools the runner sidecar cannot see in its own config.
  const manifestCommand = typeof options.toolCommand === 'string' && options.toolCommand.trim()
    ? options.toolCommand.trim()
    : '';
  const harnessId = internalHarnessId(toolId);
  const command = harnessId
    ? await resolveCommand(harnessId)
    : tool?.command || manifestCommand || await getToolCommandAsync(toolId);
  const envOverrides = buildToolProcessEnvOverrides(tool || { id: toolId });
  const runtimeFamily = (typeof options.runtimeFamily === 'string' && options.runtimeFamily.trim())
    || tool?.runtimeFamily
    || (toolId === 'claude' ? 'claude-stream-json' : toolId === 'codex' ? 'codex-app-server-json' : null);
  const invocationOptions = { ...options };
  if (isClaudeRuntimeFamily(runtimeFamily)) {
    invocationOptions.model = await resolveClaudeRuntimeModelAlias(options.model, {
      claudeHomeDir: options.claudeHomeDir,
    });
  } else if (runtimeFamily === 'codex-json' || runtimeFamily === CODEX_APP_SERVER_RUNTIME_FAMILY) {
    // 上游已下线 gpt-5.4 等历史模型；codex 未显式指定模型时兜底到配置首选
    // 模型，避免落到 codex 内置默认导致 401（opencode.ai: Model not supported）。
    if (!cleanString(options.model)) {
      invocationOptions.model = await readPreferredCodexModelFromConfig({
        homeDir: options.codexHomeDir,
      });
    }
  }
  const runtimeInvocation = buildRuntimeInvocation(runtimeFamily, prompt, invocationOptions, toolId);

  return {
    command,
    envOverrides,
    ...runtimeInvocation,
  };
}

function describeAttachmentLabel(attachment) {
  const mimeType = typeof attachment?.mimeType === 'string' ? attachment.mimeType : '';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('image/')) return 'image';
  return 'file';
}

export function prependAttachmentPaths(prompt, images) {
  const paths = (images || [])
    .map((img) => ({
      inputPath: getAttachmentExecutionPath(img),
      reference: (() => {
        const inputPath = getAttachmentExecutionPath(img);
        const displayName = getAttachmentDisplayName(img);
        if (inputPath && displayName && displayName !== inputPath) return `${displayName} -> ${inputPath}`;
        return inputPath || formatAttachmentContextReference(img);
      })(),
      label: describeAttachmentLabel(img),
    }))
    .filter((entry) => entry.inputPath);
  if (paths.length === 0) return prompt;
  const refs = paths.map((entry) => `[User attached ${entry.label}: ${entry.reference}]`).join('\n');
  return `${refs}\n\n${prompt}`;
}

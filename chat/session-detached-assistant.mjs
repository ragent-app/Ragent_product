import { randomBytes } from 'node:crypto';
import { createInterface } from 'readline';
import { join } from 'node:path';
import { CODEX_CONTROL_HOME_DIR, CONFIG_DIR } from '../lib/config.mjs';
import { getToolDefinitionAsync } from '../lib/tools.mjs';
import { buildToolProcessEnv } from '../lib/user-shell-env.mjs';
import { createToolInvocation, resolveCommandSpawnSpec } from './process-runner.mjs';
import { spawnManagedProviderProcess, terminateProviderProcessTree } from '../lib/windows-managed-spawn.mjs';
import { applyManagedRuntimeEnv } from './runtime-policy.mjs';
import { prepareControlSideNativeProvider } from './control-side-provider.mjs';
import { runCodexControlPrompt } from './codex-control-prompt.mjs';
import { resolveRunnableSessionFolder } from './session-folder.mjs';
import { appendUsageLedgerRecord, buildDetachedUsageLedgerRecord } from './usage-ledger.mjs';
import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';
import {
  prepareNativeRunProviderHome,
} from '../lib/provider-runtime/run-provider-prepare.mjs';
import {
  acquireNativeOAuthLock,
  nativeOAuthLockPath,
} from '../lib/provider-runtime/oauth-lock.mjs';
import { reconcileAgyRunCredential } from '../lib/provider-runtime/agy-credential-sync.mjs';

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const DETACHED_ASSISTANT_STDERR_PREVIEW_CHARS = 4_000;
const DETACHED_ASSISTANT_OUTPUT_MAX_CHARS = 1_048_576;
const CODEX_APP_SERVER_RUNTIME_FAMILY = 'codex-app-server-json';
const CODEX_ONE_SHOT_RUNTIME_FAMILY = 'codex-json';

async function resolveDetachedPromptRuntimeFamily(toolId) {
  const normalizedToolId = typeof toolId === 'string' ? toolId.trim() : '';
  let runtimeFamily = '';
  try {
    const tool = normalizedToolId ? await getToolDefinitionAsync(normalizedToolId) : null;
    runtimeFamily = typeof tool?.runtimeFamily === 'string' ? tool.runtimeFamily.trim() : '';
  } catch {}
  if (!runtimeFamily && normalizedToolId === 'codex') {
    runtimeFamily = CODEX_APP_SERVER_RUNTIME_FAMILY;
  }
  return runtimeFamily === CODEX_APP_SERVER_RUNTIME_FAMILY
    ? CODEX_ONE_SHOT_RUNTIME_FAMILY
    : '';
}

function appendDetachedPromptUsage(sessionMeta, usageEvent, usageTracking = {}, state = 'completed') {
  if (!usageTracking || !usageEvent) return false;
  try {
    const record = buildDetachedUsageLedgerRecord({
      session: sessionMeta,
      usageEvent,
      tracking: {
        ...usageTracking,
        state,
      },
    });
    if (!record) return false;
    return appendUsageLedgerRecord(record);
  } catch (error) {
    console.error(`[usage-ledger] Failed to append detached prompt usage for ${sessionMeta?.id?.slice?.(0, 8) || 'unknown'}: ${error.message}`);
    return false;
  }
}

export async function runDetachedAssistantPrompt(sessionMeta, prompt, options = {}) {
  const {
    folder,
    tool,
    model,
    effort,
    thinking,
  } = sessionMeta;

  if (!tool) {
    throw new Error('Detached assistant prompt requires an explicit tool');
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  const runtimeFamilyOverride = await resolveDetachedPromptRuntimeFamily(tool);
  const controlProvider = await prepareControlSideNativeProvider({
    tool,
    runtimeFamily: runtimeFamilyOverride,
    model: options.model ?? model,
    providerProfile: options.providerProfile || sessionMeta.providerProfile || '',
    claudeModelContract: options.claudeModelContract || sessionMeta.claudeModelContract || null,
    resolveProviderBinding: options.resolveProviderBinding === true,
  });
  let providerProcess = null;
  const resolvedModel = (options.model ?? model) || controlProvider?.model || '';
  try {
  if (controlProvider?.codexBroker) {
    const result = await runCodexControlPrompt({
      codexHomeDir: controlProvider.codexHomeDir,
      expectedAccountId: controlProvider.codexAccountId,
      prompt: `${options.systemPrefix || ''}${prompt}`,
      cwd: resolveRunnableSessionFolder(folder).cwd,
      model: controlProvider.model || resolvedModel.split('@')[0],
      effort: options.effort ?? effort,
      developerInstructions: options.developerInstructions || '',
      timeoutMs,
    });
    if (result.usage && options.usageTracking) {
      appendDetachedPromptUsage(sessionMeta, result.usage, {
        tool, model: resolvedModel, effort: options.effort ?? effort, ...options.usageTracking,
      });
    }
    return result.text;
  }
  const invocation = await createToolInvocation(tool, prompt, {
    dangerouslySkipPermissions: options.dangerouslySkipPermissions !== false,
    model: resolvedModel,
    permissionMode: options.permissionMode,
    interactionMode: options.interactionMode,
    maxTurns: options.maxTurns,
    allowedTools: options.allowedTools,
    effort: options.effort ?? effort,
    thinking: options.thinking ?? thinking,
    systemPrefix: Object.prototype.hasOwnProperty.call(options, 'systemPrefix')
      ? options.systemPrefix
      : '',
    developerInstructions: options.developerInstructions,
    ...(runtimeFamilyOverride ? { runtimeFamily: runtimeFamilyOverride } : {}),
    ...(controlProvider?.claudeHomeDir ? { claudeHomeDir: controlProvider.claudeHomeDir } : {}),
    ...(controlProvider?.codexHomeDir ? { codexHomeDir: controlProvider.codexHomeDir } : {}),
  });
  const resolvedFolder = resolveRunnableSessionFolder(folder);
  if (resolvedFolder.repaired) {
    console.log(
      `[detached-assistant] Repaired session cwd for ${sessionMeta?.id?.slice?.(0, 8) || 'unknown'}: ${resolvedFolder.requestedCwd} -> ${resolvedFolder.cwd} (${resolvedFolder.reason})`,
    );
  }
  const env = buildToolProcessEnv(invocation.envOverrides || {});
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // 与主链路同款 managed runtime env（CLAUDE_CONFIG_DIR/HOME/ANTHROPIC_*、
  // CODEX_HOME/auth）：detached 派生调用同样需要登录态与上游形态，
  // 否则 claude 直连形态报 Not logged in（实测），codex 亦无 managed home。
  const isAgy = invocation.isAgyFamily === true;
  const agyProviderProfile = isAgy
    ? (options.providerProfile || sessionMeta.agyProviderProfileId || sessionMeta.providerProfile || '')
    : '';
  const agyRunId = isAgy
    ? `run_detached_${randomBytes(12).toString('hex')}`
    : '';
  const agyProviderHomesRoot = join(CONFIG_DIR, 'provider-runtime-homes', 'detached');
  const agyManifest = isAgy
    ? {
      tool: 'agy',
      options: {
        runtimeFamily: invocation.runtimeFamily,
        model: options.model ?? model,
        ...(agyProviderProfile ? { providerProfile: agyProviderProfile } : {}),
      },
    }
    : null;
  const agyPreparation = isAgy
    ? await prepareNativeRunProviderHome(agyRunId, agyManifest, {
      configDir: CONFIG_DIR,
      providerHomesRoot: agyProviderHomesRoot,
      externalOAuthOwnership: false,
    })
    : null;
  if (isAgy && (!agyPreparation?.ok || !agyPreparation.agyHomeDir)) {
    throw new Error(`Native AgY provider preparation failed: ${agyPreparation?.error || agyPreparation?.reason || 'unknown error'}`);
  }
  const managedEnv = await applyManagedRuntimeEnv(tool, env, {
    ...(controlProvider?.codexHomeDir ? { codexHomeDir: controlProvider.codexHomeDir } : {}),
    ...(isAgy ? { runtimeFamily: invocation.runtimeFamily, agyHomeDir: agyPreparation.agyHomeDir } : {}),
    ...(controlProvider?.claudeHomeDir ? {
      runtimeFamily: invocation.runtimeFamily,
      claudeHomeDir: controlProvider.claudeHomeDir,
      claudeHomeBridgeDir: controlProvider.claudeHomeBridgeDir,
    } : {}),
  });
  Object.assign(env, managedEnv);
  const resolvedCmd = await resolveCommandSpawnSpec(invocation.command, invocation.args, {
    cwd: resolvedFolder.cwd,
    env,
  });

  // OAuth bindings returned above already use the single broker. Static
  // Codex credentials keep a per-operation home and the existing CLI path.
  const isCodexRuntime = invocation.isCodexFamily === true;
  const codexHomeDir = isCodexRuntime
    ? (typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim()
      ? env.CODEX_HOME.trim()
      : CODEX_CONTROL_HOME_DIR)
    : '';
  let nativeOAuthLock = null;
  if (codexHomeDir) {
    nativeOAuthLock = await acquireNativeOAuthLock(nativeOAuthLockPath(codexHomeDir));
  }

  let proc;
  try {
    // Managed provider spawn: POSIX keeps the detached process group (so the
    // timeout can signal the whole tree), win32 gets a Job Object with
    // whole-tree termination.
    proc = await spawnManagedProviderProcess(resolvedCmd, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    providerProcess = proc;
  } catch (error) {
    await nativeOAuthLock?.release?.().catch(() => {});
    throw error;
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let lockReleased = false;
    const releaseNativeOAuthLock = async () => {
      if (!nativeOAuthLock || lockReleased) return;
      lockReleased = true;
      try {
        await nativeOAuthLock.release();
      } catch (error) {
        console.error(`[detached-assistant] Failed to release Codex OAuth lock: ${error.message}`);
      }
    };
    proc.stdin.end(typeof invocation.input === 'string' ? invocation.input : '');

    // stderr is piped so the caller can keep the provider isolated, but it
    // must still be drained. Leaving this pipe unread lets a noisy harness
    // fill the kernel buffer and block stdout forever, which looks like a
    // hung planner/labeler even though the provider is still running.
    let stderrPreview = '';
    proc.stderr?.on('data', (chunk) => {
      const text = String(chunk || '');
      if (!text) return;
      stderrPreview = `${stderrPreview}${text}`.slice(-DETACHED_ASSISTANT_STDERR_PREVIEW_CHARS);
    });

    const terminateAfterFailure = () => {
      terminateProviderProcessTree(proc, 'SIGTERM');
      const killTimer = setTimeout(() => {
        terminateProviderProcessTree(proc, 'SIGKILL');
      }, 5000);
      killTimer.unref?.();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateAfterFailure();
      reject(new Error(`Detached assistant prompt timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    timer.unref?.();

    const rl = createInterface({ input: proc.stdout });
    const textParts = [];
    let outputChars = 0;
    let latestUsageEvent = null;

    rl.on('line', (line) => {
      if (settled) return;
      try {
        const events = invocation.adapter.parseLine(line);
        for (const evt of events || []) {
          if (evt.type === 'message' && evt.role === 'assistant') {
            const content = typeof evt.content === 'string' ? evt.content : '';
            outputChars += content.length;
            if (outputChars > DETACHED_ASSISTANT_OUTPUT_MAX_CHARS) {
              settled = true;
              clearTimeout(timer);
              terminateAfterFailure();
              reject(new Error(`Detached assistant provider output exceeded ${DETACHED_ASSISTANT_OUTPUT_MAX_CHARS} characters`));
              return;
            }
            textParts.push(content);
          } else if (evt.type === 'usage') {
            latestUsageEvent = evt;
          }
        }
      } catch (error) {
        const detail = error?.message || String(error);
        settled = true;
        clearTimeout(timer);
        terminateAfterFailure();
        reject(new Error(`Detached assistant provider output could not be parsed: ${detail}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      void releaseNativeOAuthLock().finally(() => reject(err));
    });

    proc.on('exit', (code) => {
      void (async () => {
        clearTimeout(timer);
        // A timeout rejects the caller before the provider necessarily exits;
        // release only from the exit path so another Codex process cannot
        // refresh the same auth.json while the terminated tree is unwinding.
        await releaseNativeOAuthLock();
        if (settled) return;
        settled = true;
        if (isAgy) {
          await reconcileAgyRunCredential({
            run: {
              id: agyRunId,
              tool: 'agy',
              runtimeFamily: invocation.runtimeFamily,
              agyProviderProfileId: agyPreparation.providerId,
            },
            manifest: agyManifest,
            configDir: CONFIG_DIR,
            providerHomesRoot: agyProviderHomesRoot,
            registry: createNativeProviderRegistry({ configDir: CONFIG_DIR }),
            secretStore: createSecretStore({ configDir: CONFIG_DIR }),
          });
        }
        if (latestUsageEvent && options.usageTracking) {
          appendDetachedPromptUsage(sessionMeta, latestUsageEvent, {
            tool: options.tool ?? tool,
            model: options.model ?? model,
            effort: options.effort ?? effort,
            ...options.usageTracking,
          }, code === 0 ? 'completed' : 'failed');
        }
        const raw = textParts.join('\n').trim();
        if (code !== 0 && !raw) {
          const stderr = stderrPreview.trim();
          reject(new Error(`${tool} exited with code ${code}${stderr ? `: ${stderr.slice(-500)}` : ''}`));
          return;
        }
        resolve(raw);
      })().catch(reject);
    });
  });
  } finally {
    // A timeout rejects before whole-tree termination completes. Keep the
    // isolated home until the provider has actually exited.
    if (providerProcess && providerProcess.exitCode === null && providerProcess.signalCode === null) {
      providerProcess.once('close', () => { void controlProvider?.cleanup?.(); });
    } else {
      await controlProvider?.cleanup?.();
    }
  }
}

import { isAbsolute } from 'node:path';
import { buildCodexAppServerEnvironmentAddMessage } from './codex-app-server-protocol.mjs';
import { prepareReadOnlyCodexMcp } from './codex-readonly-mcp.mjs';

// Called on the Run's private broker connection. A thread may start only
// after its scoped MCP config and authenticated executor have been verified.
export function createCodexReadOnlyEnvironmentSetup({ environmentId, cwd, workspace, hidePaths, executor,
  nextRequestId, send, onReady, onFailure, prepareMcp = prepareReadOnlyCodexMcp, timeoutMs = 30_000, readOnly = true, runnerHome = '' } = {}) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || !executor?.stop || typeof nextRequestId !== 'function'
      || typeof send !== 'function' || typeof onReady !== 'function' || typeof onFailure !== 'function'
      || !Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new TypeError('Invalid Codex read-only environment setup');
  }
  let stage = 'new', pendingId = null, resources = null, timer = null, closing = null;
  const close = () => {
    if (!closing) {
      stage = 'closed'; clearTimeout(timer);
      closing = Promise.allSettled([Promise.resolve().then(() => executor.stop()),
        Promise.resolve().then(() => resources?.cleanup?.())]);
    }
    return closing;
  };
  const fail = () => {
    if (stage === 'closed' || stage === 'failed') return;
    const failedStage = stage;
    stage = 'failed'; clearTimeout(timer);
    try { onFailure({ code: 'CODEX_READONLY_ENVIRONMENT_UNAVAILABLE', stage: failedStage, message: 'Codex read-only execution environment is unavailable' }); }
    finally { void close(); }
  };
  const issue = (method, params) => {
    const id = nextRequestId();
    pendingId = id;
    try {
      if (!Number.isSafeInteger(id) || id < 0 || !send({ id, method, params })) { fail(); return false; }
      return true;
    } catch { fail(); return false; }
  };
  return {
    start() {
      if (stage !== 'new') return false;
      stage = 'config';
      timer = setTimeout(fail, timeoutMs); timer.unref?.();
      return issue('config/read', { cwd, includeLayers: false });
    },
    async consume(message) {
      if (stage === 'new' || stage === 'closed' || stage === 'failed' || pendingId === null || message?.id !== pendingId) return false;
      pendingId = null;
      if (message.error || !message.result || typeof message.result !== 'object') { fail(); return true; }
      try {
        if (stage === 'config') {
          const config = message.result.config;
          if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Missing configuration');
          resources = await prepareMcp({ servers: config.mcp_servers ?? {}, cwd, workspace, hidePaths, readOnly, runnerHome });
          if (stage !== 'config') { await resources?.cleanup?.(); return true; }
          stage = 'register';
          const id = nextRequestId();
          const request = buildCodexAppServerEnvironmentAddMessage({ id, environmentId,
            execServerUrl: executor.execServerUrl, authBearerToken: executor.authBearerToken });
          if (!send(request)) throw new Error('Could not register execution environment');
          pendingId = id;
        } else if (stage === 'register') {
          stage = 'verify'; issue('environment/info', { environmentId });
        } else if (stage === 'verify') {
          if (!message.result.shell || typeof message.result.shell.path !== 'string' || !message.result.shell.path.trim()) throw new Error('Executor did not report its shell');
          stage = 'ready'; clearTimeout(timer);
          onReady({ executionEnvironment: { environmentId, cwd }, threadMcpConfig: resources.config });
        }
      } catch { fail(); }
      return true;
    },
    close,
  };
}

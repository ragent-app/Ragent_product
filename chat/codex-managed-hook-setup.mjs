import { win32 } from 'node:path';

// Trust only the exact AgentoC-owned definition reported by the app-server.
// Writes target the private run overlay, never the owner's provider config.
export function createCodexManagedHookSetup({ cwd, configPath, sourcePath = configPath, source = 'user', command, nextRequestId, send, onDone, timeoutMs = 10000 } = {}) {
  let pending = null; let phase = 'idle'; let timer = null; let selected = null;
  const pathKey = value => win32.resolve(String(value || '')).toLowerCase();
  const finish = ready => {
    if (phase === 'done') return;
    phase = 'done'; pending = null; if (timer) clearTimeout(timer); timer = null;
    onDone?.(ready === true, ready === true ? selected : null);
  };
  const request = (method, params, nextPhase) => {
    const id = nextRequestId(); pending = id; phase = nextPhase;
    if (!send({ id, method, params })) finish(false);
  };
  const match = result => {
    const groups = result?.data;
    if (!Array.isArray(groups)) return null;
    const hooks = groups.flatMap(group => Array.isArray(group?.hooks) ? group.hooks : []);
    const matches = hooks.filter(hook => hook?.source === source && hook.isManaged === false && hook.enabled === true &&
      hook.eventName === 'preToolUse' && hook.handlerType === 'command' && hook.matcher === '^Bash$' && hook.command === command &&
      typeof hook.sourcePath === 'string' && pathKey(hook.sourcePath) === pathKey(sourcePath) &&
      typeof hook.key === 'string' && hook.key.toLowerCase().startsWith(`${sourcePath.toLowerCase()}:pre_tool_use:`) &&
      /^sha256:[a-f0-9]{64}$/.test(hook.currentHash || ''));
    return matches.length === 1 ? matches[0] : null;
  };
  return {
    start() {
      if (phase !== 'idle') return;
      if (!['user', 'sessionFlags'].includes(source) || !win32.isAbsolute(configPath || '') || !win32.isAbsolute(sourcePath || '') || !win32.isAbsolute(cwd || '') || !command ||
          typeof nextRequestId !== 'function' || typeof send !== 'function') { finish(false); return; }
      timer = setTimeout(() => finish(false), timeoutMs); timer.unref?.();
      request('hooks/list', { cwds: [cwd] }, 'list');
    },
    consume(message) {
      if (phase === 'done' || phase === 'idle' || message?.id !== pending) return false;
      if (message.error) { finish(false); return true; }
      if (phase === 'list') {
        selected = match(message.result);
        if (!selected) { finish(false); return true; }
        request('config/batchWrite', { filePath: configPath, reloadUserConfig: true, edits: [{ keyPath: 'hooks.state',
          mergeStrategy: 'upsert', value: { [selected.key]: { trusted_hash: selected.currentHash } } }] }, 'write');
      } else if (phase === 'write') request('hooks/list', { cwds: [cwd] }, 'verify');
      else if (phase === 'verify') {
        const verified = match(message.result);
        const ready = Boolean(verified && verified.key === selected.key && verified.currentHash === selected.currentHash && verified.trustStatus === 'trusted');
        if (ready) selected = verified;
        finish(ready);
      }
      return true;
    },
    cancel() { if (phase !== 'done') { phase = 'done'; pending = null; if (timer) clearTimeout(timer); timer = null; } },
  };
}

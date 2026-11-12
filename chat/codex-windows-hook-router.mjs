import { resolve, win32 } from 'node:path';

// Match a callback to an actual in-flight managed hook reported by Codex.
// A hook's self-reported session/turn IDs alone are not authorization.
export function createCodexWindowsHookRouter({ sourcePath, runIdPrefix, getOwner, now = Date.now, ttlMs = 30_000 } = {}) {
  const normalize = value => typeof value === 'string' && value ?
    (win32.isAbsolute(value) ? win32.resolve(value).toLowerCase() : resolve(value)) : '';
  const expectedPath = normalize(sourcePath);
  const pending = new Map();
  const key = (threadId, turnId, runId) => JSON.stringify([threadId, turnId, runId]);
  const sweep = () => { for (const [id, entry] of pending) if (entry.expires <= now()) pending.delete(id); };
  return {
    observe(message) {
      sweep();
      const params = message?.params || {};
      const run = params.run || {};
      if (!params.threadId || !params.turnId || !run.id) return;
      const id = key(params.threadId, params.turnId, run.id);
      if (message.method === 'hook/completed') { pending.delete(id); return; }
      if (message.method !== 'hook/started' || !expectedPath || !runIdPrefix || !run.id.startsWith(runIdPrefix) || normalize(run.sourcePath) !== expectedPath
          || run.eventName !== 'preToolUse' || run.handlerType !== 'command'
          || run.executionMode !== 'sync' || run.status !== 'running') return;
      const owner = getOwner?.(params.threadId);
      if (owner && !owner.destroyed) pending.set(id, { owner, threadId: params.threadId, turnId: params.turnId, runId: run.id, expires: now() + ttlMs });
    },
    claim(event) {
      sweep();
      if (event?.hook_event_name !== 'PreToolUse' || event?.tool_name !== 'Bash'
          || typeof event.session_id !== 'string' || !event.session_id
          || typeof event.turn_id !== 'string' || !event.turn_id
          || typeof event.tool_use_id !== 'string' || !event.tool_use_id || event.tool_use_id.length > 1024
          || typeof event.tool_input?.command !== 'string' || event.tool_input.command.length > 256 * 1024) return null;
      const candidates = [...pending.entries()].filter(([, entry]) => entry.threadId === event.session_id && entry.turnId === event.turn_id
        && entry.runId === `${runIdPrefix}${event.tool_use_id}` && !entry.owner.destroyed && getOwner?.(entry.threadId) === entry.owner);
      if (candidates.length !== 1) return null;
      const [id, entry] = candidates[0];
      pending.delete(id);
      return entry.owner;
    },
    release(owner) { for (const [id, entry] of pending) if (entry.owner === owner) pending.delete(id); },
  };
}

// Track provider turns independently of client connections. A disconnected
// client does not prove its Codex turn has stopped, so the broker must retain
// this state until an upstream completion or failed start confirms that.
export function createCodexBrokerTurnActivity() {
  const activeThreads = new Set();
  const starting = new Map();
  const requests = new Set();
  const oauthNames = new Set();
  const oauthRequests = new Map();
  let uncertain = false;
  const threadId = (message) => {
    const id = message?.params?.threadId ?? message?.params?.thread_id;
    return typeof id === 'string' && id.trim() ? id.trim() : '';
  };
  return {
    startRequest(message) {
      if (typeof message?.method === 'string' && (typeof message.id === 'string' || typeof message.id === 'number')) requests.add(message.id);
      if (message?.method === 'mcpServer/oauth/login') {
        const name = typeof message.params?.name === 'string' ? message.params.name.trim() : '';
        if (!name || (typeof message.id !== 'string' && typeof message.id !== 'number') || oauthNames.has(name)) { uncertain = true; return; }
        oauthNames.add(name);
        oauthRequests.set(message.id, name);
        return;
      }
      if (!['turn/start', 'review/start', 'thread/compact/start'].includes(message?.method)) return;
      const thread = threadId(message);
      if (!thread || (typeof message.id !== 'string' && typeof message.id !== 'number')) { uncertain = true; return; }
      starting.set(message.id, thread);
    },
    upstream(message) {
      if (!message || typeof message !== 'object') return;
      if (!message.method && (typeof message.id === 'string' || typeof message.id === 'number')) requests.delete(message.id);
      if (!message.method && oauthRequests.has(message.id)) {
        const name = oauthRequests.get(message.id);
        oauthRequests.delete(message.id);
        if (message.error) oauthNames.delete(name);
        return;
      }
      if (message.method === 'mcpServer/oauthLogin/completed') {
        const name = typeof message.params?.name === 'string' ? message.params.name.trim() : '';
        if (!name) { uncertain = true; return; }
        oauthNames.delete(name);
        return;
      }
      if (!message.method && starting.has(message.id)) {
        const thread = starting.get(message.id);
        starting.delete(message.id);
        if (!message.error) activeThreads.add(thread);
        return;
      }
      if (message.method !== 'turn/started' && message.method !== 'turn/completed') return;
      const thread = threadId(message);
      if (!thread) { uncertain = true; return; }
      if (message.method === 'turn/started') activeThreads.add(thread);
      else activeThreads.delete(thread);
    },
    isIdle() { return !uncertain && activeThreads.size === 0 && starting.size === 0 && requests.size === 0 && oauthNames.size === 0 && oauthRequests.size === 0; },
  };
}

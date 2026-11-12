import { CHAT_PORT } from '../lib/config.mjs';
import { LINUX_RUN_SCOPE_FINISH_PATH } from './linux-run-scope-finish-path.mjs';

export async function notifyLinuxRunScopeFinished(run, manifest, {
  base = process.env.AGENTOC_CHAT_BASE_URL || `http://127.0.0.1:${CHAT_PORT}`,
} = {}) {
  try {
    const url = new URL(base);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    const body = { runId: run?.id, sessionId: run?.sessionId, turnId: run?.requestId,
      launchAttempt: run?.runnerLaunchAttempt ?? 0, token: manifest?.options?.approvedActionChannel?.token };
    const response = await fetch(new URL(LINUX_RUN_SCOPE_FINISH_PATH, url), { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    // The response is bounded and contains no token or Run data.
    const length = response.headers.get('content-length');
    if (length && Number(length) > 1024) return false;
    if (!response.body) return false;
    let result = '';
    for await (const chunk of response.body) {
      result += Buffer.from(chunk).toString('utf8');
      if (Buffer.byteLength(result, 'utf8') > 1024) return false;
    }
    return JSON.parse(result)?.invalidated === true;
  } catch { return false; }
}

import { randomBytes } from 'node:crypto';
import { CHAT_PORT } from '../lib/config.mjs';
import { LINUX_RUN_ACTIVE_CHECK_PATH, verifyLinuxRunActiveProof } from '../chat/linux-run-active-proof.mjs';

// Called under the root operation lock. A local socket address is not an
// identity: the response must also verify under the root-pinned service key.
export async function checkLinuxRunActive(state, { publicKey,
  base = process.env.AGENTOC_CHAT_BASE_URL || `http://127.0.0.1:${CHAT_PORT}` } = {}) {
  try {
    if (process.platform !== 'linux' || process.geteuid?.() !== 0) return false;
    const url = new URL(base);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    const context = { runId: state?.runId, sessionId: state?.sessionId, turnId: state?.turnId,
      launchAttempt: state?.launchAttempt, invocationId: state?.invocationId, challenge: randomBytes(32).toString('base64url') };
    const response = await fetch(new URL(LINUX_RUN_ACTIVE_CHECK_PATH, url), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(context),
      redirect: 'error', signal: AbortSignal.timeout(2000),
    });
    if (!response.ok || !response.body) return false;
    let text = '';
    for await (const chunk of response.body) {
      text += Buffer.from(chunk).toString('utf8');
      if (Buffer.byteLength(text, 'utf8') > 4096) return false;
    }
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'proof')) return false;
    return verifyLinuxRunActiveProof(body.proof, { expectedContext: context, publicKey });
  } catch { return false; }
}

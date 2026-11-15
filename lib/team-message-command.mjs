import { createRagentHttpClient } from './ragent-http-client.mjs';

// Uses the Run's signed message-only capability from its protected runtime
// channel; neither node identity nor session authority comes from the caller.
export async function runTeamMessageCommand(argv = [], io = {}) {
  const [action, messageId, ...args] = argv;
  if (!['ack','reply'].includes(action) || !messageId) throw new Error('Usage: ragent team-message ack <messageId> | reply <messageId> --text <text> --idempotency-key <key>');
  const sessionId = String(process.env.RAGENT_SESSION_CONTROL_SESSION_ID || '').trim();
  if (!sessionId || !process.env.RAGENT_SESSION_CONTROL_TOKEN) throw new Error('A scoped managed Run capability is required');
  let body = '', idempotencyKey = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--text') body = args[++i] || '';
    else if (args[i] === '--idempotency-key') idempotencyKey = args[++i] || '';
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  if (action === 'reply' && (!body.trim() || !idempotencyKey.trim())) throw new Error('Reply requires --text and a stable --idempotency-key');
  const client = createRagentHttpClient();
  const result = await client.request(`/api/sessions/${encodeURIComponent(sessionId)}/organization/messages/${encodeURIComponent(messageId)}/${action}`, {
    method: 'POST', body: action === 'reply' ? { body, idempotencyKey } : {},
  });
  if (!result.response.ok) throw new Error(result.json?.error || result.text || `Message request failed (${result.response.status})`);
  (io.stdout || process.stdout).write(`${JSON.stringify(result.json)}\n`);
  return 0;
}

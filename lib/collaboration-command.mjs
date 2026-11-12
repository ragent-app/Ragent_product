import { readFile } from 'fs/promises';
import { createAgentoCHttpClient } from './agentoc-http-client.mjs';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const CAPABILITY_OPERATION_BY_ACTION = Object.freeze({
  status: 'collaboration.read',
  create: 'collaboration.create',
  dispatch: 'collaboration.dispatch',
  retry: 'collaboration.retry',
  cancel: 'collaboration.cancel',
});

export function readRunCollaborationCapability(operation, environment = process.env) {
  const encoded = text(environment.AGENTOC_COLLABORATION_CAPABILITIES);
  if (!encoded) return '';
  try {
    const records = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const match = Array.isArray(records)
      ? records.find((entry) => entry?.operation === operation && text(entry?.token))
      : null;
    return text(match?.token);
  } catch {
    return '';
  }
}

export function collaborationCapabilityOperationForRequest(pathname, method) {
  const normalizedPath = text(pathname).split('?')[0];
  const normalizedMethod = text(method).toUpperCase();
  if (normalizedPath === '/api/collaborations' && normalizedMethod === 'GET') return 'collaboration.read';
  if (normalizedPath === '/api/collaborations' && normalizedMethod === 'POST') return 'collaboration.create';
  const action = /^\/api\/collaborations\/[^/]+\/(dispatch|retry|cancel)$/.exec(normalizedPath)?.[1] || '';
  return normalizedMethod === 'POST' ? (CAPABILITY_OPERATION_BY_ACTION[action] || '') : '';
}

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage:\n  ragent collaborate status [id]\n  ragent collaborate create --root-session <id> --plan-file <path> [options]\n  ragent collaborate dispatch <id>\n  ragent collaborate retry <id>\n  ragent collaborate cancel <id> [--reason <text>]\n\nOptions:\n  --title <text>             Collaboration title\n  --idempotency-key <key>    Stable create key\n  --base-url <url>           Ragent base URL\n  --help                     Show this help\n`);
}

function parseArgs(argv) {
  const args = [...argv];
  const options = { positional: [] };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--title') options.title = args.shift() || '';
    else if (arg === '--plan-file') options.planFile = args.shift() || '';
    else if (arg === '--root-session') options.rootSessionId = args.shift() || '';
    else if (arg === '--idempotency-key') options.idempotencyKey = args.shift() || '';
    else if (arg === '--reason') options.reason = args.shift() || '';
    else if (arg === '--base-url') options.baseUrl = args.shift() || '';
    else options.positional.push(arg);
  }
  return options;
}

async function loadPlan(path) {
  if (!text(path)) throw new Error('--plan-file is required for create');
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function runCollaborationCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const options = parseArgs(argv);
  if (options.help || options.positional.length === 0) {
    printHelp(stdout);
    return options.help ? 0 : 1;
  }
  const [action, id] = options.positional;
  const capabilityOperation = CAPABILITY_OPERATION_BY_ACTION[action] || '';
  const capabilityToken = readRunCollaborationCapability(capabilityOperation);
  const hasCapabilityEnvelope = !!text(process.env.AGENTOC_COLLABORATION_CAPABILITIES);
  if (hasCapabilityEnvelope && !capabilityToken) {
    throw new Error(`No valid Run-scoped collaboration capability for ${capabilityOperation}`);
  }
  const client = createAgentoCHttpClient({ baseUrl: options.baseUrl, capabilityToken });
  let path;
  let body;
  if (action === 'status') {
    path = id ? `/api/collaborations/${encodeURIComponent(id)}` : '/api/collaborations';
  } else if (action === 'create') {
    path = '/api/collaborations';
    body = {
      rootSessionId: text(options.rootSessionId),
      title: text(options.title),
      idempotencyKey: text(options.idempotencyKey),
      plan: await loadPlan(options.planFile),
    };
  } else if (['dispatch', 'retry', 'cancel'].includes(action)) {
    if (!text(id)) throw new Error(`${action} requires a collaboration id`);
    path = `/api/collaborations/${encodeURIComponent(id)}/${action}`;
    body = action === 'cancel' ? { reason: text(options.reason) } : {};
  } else {
    throw new Error(`Unknown collaboration action: ${action}`);
  }
  const result = await client.request(path, {
    method: body ? 'POST' : 'GET',
    ...(body ? { body } : {}),
  });
  if (!result.response.ok) throw new Error(result.json?.error || result.text || `Collaboration request failed (${result.response.status})`);
  stdout.write(`${JSON.stringify(result.json ?? { text: result.text }, null, 2)}\n`);
  return 0;
}

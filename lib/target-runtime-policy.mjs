// Shared target-runtime request policy. The policy is intentionally small and
// path based: Accounts grants one exact method/path pair and the runtime
// refuses every control-plane, credential, and transport endpoint.

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const BLOCKED_PREFIXES = Object.freeze([
  '/api/auth',
  '/api/account',
  '/api/device',
  '/api/entry-switch',
  '/api/target-runtime',
  '/api/connectivity',
  '/api/provider-sync',
  '/api/push',
  '/api/owner',
  '/api/fcm',
  '/api/internal',
  '/api/install',
  '/api/onboarding',
  '/api/analytics',
  '/api/sync',
  '/api/device-handshake',
]);

function text(value, max = 2048) {
  return (typeof value === 'string' ? value.trim() : '').slice(0, max);
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

export function normalizeTargetRuntimePath(value) {
  const raw = text(value);
  if (!raw || raw.length > 2048 || !raw.startsWith('/') || raw.startsWith('//')) {
    throw fail('TARGET_PATH_INVALID', 'Target runtime path must be an absolute local path.');
  }
  if (raw.includes('#') || /(?:%2f|%5c|%2e|\\)/i.test(raw)) {
    throw fail('TARGET_PATH_INVALID', 'Encoded separators and fragments are not allowed.');
  }
  let parsed;
  try {
    parsed = new URL(raw, 'https://target-runtime.invalid');
  } catch {
    throw fail('TARGET_PATH_INVALID', 'Target runtime path is invalid.');
  }
  const path = `${parsed.pathname}${parsed.search}`;
  if (!path.startsWith('/api/') || path.includes('/../') || path.endsWith('/..')) {
    throw fail('TARGET_PATH_FORBIDDEN', 'Target runtime path is not a business API path.');
  }
  return path;
}

function isBlockedPath(pathname) {
  return BLOCKED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function sessionOperation(method, pathname) {
  if (pathname === '/api/sessions' || pathname.startsWith('/api/sessions/')) {
    if (method === 'GET') return 'session.read';
    if (pathname === '/api/sessions' && method === 'POST') return 'session.create';
    if (method === 'PATCH') return 'session.update';
    if (method === 'DELETE') return 'session.delete';
    const action = pathname.split('/').filter(Boolean).at(-1) || '';
    if (action === 'cancel') return 'session.cancel';
    if (action === 'compact') return 'session.compact';
    if (action === 'drop-tools') return 'session.drop-tools';
    if (action === 'fork' || action === 'fork-at') return 'session.fork';
    if (action === 'queue') return 'session.queue';
    if (action === 'messages' || action === 'resend-edited' || action === 'regenerate') return 'session.message';
    if (action === 'goal' || action === 'control' || action === 'confirm') return 'session.update';
    if (method === 'POST') return 'session.message';
  }
  return '';
}

export function classifyTargetRuntimeRequest(methodInput, pathInput) {
  const method = text(methodInput, 16).toUpperCase() || 'GET';
  if (!METHODS.has(method)) return null;
  let path;
  try {
    path = normalizeTargetRuntimePath(pathInput);
  } catch {
    return null;
  }
  const pathname = path.split('?', 1)[0];
  if (isBlockedPath(pathname)) return null;

  if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/organization/projection') && method === 'GET') {
    return { method, path, operation: 'workflow.read' };
  }
  const session = sessionOperation(method, pathname);
  if (session) return { method, path, operation: session };
  if (pathname.startsWith('/api/root-sessions/')) {
    return { method, path, operation: method === 'GET' ? 'session.read' : 'session.message' };
  }
  if (pathname === '/api/projects' || pathname.startsWith('/api/projects/')) {
    return { method, path, operation: method === 'GET' ? 'project.read' : 'project.write' };
  }
  if (pathname.startsWith('/api/project-handoffs/')) {
    return { method, path, operation: method === 'GET' ? 'project.read' : 'project.write' };
  }
  if (pathname === '/api/runs' || pathname.startsWith('/api/runs/')) {
    if (method === 'GET') return { method, path, operation: 'run.read' };
    if (method === 'POST' && pathname.endsWith('/cancel')) return { method, path, operation: 'run.cancel' };
    if (method === 'POST' && (pathname.endsWith('/resolve')
      || pathname.includes('/approvals/')
      || pathname.includes('/approved-actions/')
      || pathname.includes('/privileged-batches/'))) {
      return { method, path, operation: 'approval.resolve' };
    }
  }
  if (pathname === '/api/approvals' || pathname.startsWith('/api/approvals/')) {
    return { method, path, operation: method === 'GET' ? 'approval.read' : 'approval.resolve' };
  }
  if (pathname === '/api/home' && method === 'GET') return { method, path, operation: 'home.read' };
  if (pathname === '/api/tools') return { method, path, operation: method === 'GET' ? 'tool.read' : 'tool.write' };
  if (pathname === '/api/harnesses' || pathname.startsWith('/api/harnesses/')) {
    return { method, path, operation: method === 'GET' ? 'tool.read' : 'tool.write' };
  }
  if (pathname === '/api/models' && method === 'GET') return { method, path, operation: 'model.read' };
  if (pathname === '/api/agents' || pathname.startsWith('/api/agents/')) {
    return { method, path, operation: method === 'GET' ? 'agent.read' : 'agent.write' };
  }
  if (pathname === '/api/native-providers' || pathname.startsWith('/api/native-providers/')) {
    return { method, path, operation: method === 'GET' ? 'provider.read' : 'provider.write' };
  }
  if (pathname === '/api/native-provider-oauth/jobs' || pathname.startsWith('/api/native-provider-oauth/jobs/')) {
    return { method, path, operation: method === 'GET' ? 'provider.read' : 'provider.write' };
  }
  if (pathname === '/api/connectors' || pathname.startsWith('/api/connectors/') || pathname.startsWith('/api/codex/mcp-servers')
      || pathname.startsWith('/api/claude/mcp-servers')) {
    return { method, path, operation: method === 'GET' ? 'connector.read' : 'connector.write' };
  }
  if (pathname === '/api/autocomplete' || pathname === '/api/browse'
      || pathname.startsWith('/api/workspace-files') || pathname.startsWith('/api/assets/')
      || pathname.startsWith('/api/images/') || pathname.startsWith('/api/media/')) {
    const assetUpload = pathname.startsWith('/api/assets/') && pathname.endsWith('/upload');
    if (method === 'GET' || (method !== 'PUT' && method !== 'POST' && method !== 'PATCH' && method !== 'DELETE')) return { method, path, operation: 'file.read' };
    if (assetUpload && method === 'PUT') return { method, path, operation: 'file.write' };
    if (method === 'POST' || method === 'PATCH' || method === 'DELETE') return { method, path, operation: 'file.write' };
    return null;
  }
  if (pathname === '/api/browse/mkdir') return { method, path, operation: 'file.write' };
  if (pathname === '/api/triggers' || pathname.startsWith('/api/triggers/')) {
    return { method, path, operation: method === 'GET' ? 'trigger.read' : 'trigger.write' };
  }
  if (pathname.startsWith('/api/usage') || pathname === '/api/mailbox/status') {
    return { method, path, operation: 'usage.read' };
  }
  if (pathname.startsWith('/api/harnesses/')) {
    return { method, path, operation: method === 'GET' ? 'tool.read' : 'tool.write' };
  }
  if (pathname === '/api/notifications' && method === 'GET') {
    return { method, path, operation: 'notification.read' };
  }
  if (pathname === '/api/notifications' && method === 'POST') {
    return { method, path, operation: 'notification.write' };
  }
  if (pathname.startsWith('/api/managed-processes')
      || pathname.startsWith('/api/orchestrations')
      || pathname.startsWith('/api/collaborations')
      || pathname.startsWith('/api/consultations')
      || pathname.startsWith('/api/organization')
      || pathname.startsWith('/api/organizations')) {
    return { method, path, operation: method === 'GET' ? 'workflow.read' : 'workflow.write' };
  }
  if ((pathname === '/api/runtime/summary' || pathname === '/api/runtime/summary/events') && method === 'GET') {
    return { method, path, operation: 'runtime.summary' };
  }
  if (pathname === '/api/runtime-selection' && method === 'GET') {
    return { method, path, operation: 'settings.read' };
  }
  if (pathname === '/api/runtime-selection' && method === 'POST') {
    return { method, path, operation: 'settings.write' };
  }
  if (pathname === '/api/local-voice-settings') {
    if (method === 'GET') return { method, path, operation: 'voice.settings.read' };
    if (method === 'PATCH') return { method, path, operation: 'voice.settings.write' };
    return null;
  }
  if (pathname === '/api/local-voice-install' && method === 'POST') {
    return { method, path, operation: 'voice.install' };
  }
  if (/^\/api\/local-voice-install\/[a-f0-9-]{36}$/.test(pathname) && method === 'GET') {
    return { method, path, operation: 'voice.install.read' };
  }
  if (pathname === '/api/local-voice-recognition' && method === 'POST') {
    return { method, path, operation: 'voice.recognition' };
  }
  if (pathname === '/api/bootstrap/owner-sessions/restore' && method === 'POST') {
    return { method, path, operation: 'session.update' };
  }
  if ((pathname === '/api/shortcut' || pathname === '/api/agy/execute') && method === 'POST') {
    return { method, path, operation: 'workflow.write' };
  }
  if ((pathname === '/api/agy/models' || pathname === '/api/agy/agents' || pathname === '/api/agy/version') && method === 'GET') {
    return { method, path, operation: 'tool.read' };
  }
  return null;
}

export const TARGET_RUNTIME_BLOCKED_PREFIXES = BLOCKED_PREFIXES;

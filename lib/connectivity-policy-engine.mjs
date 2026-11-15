import { temporaryCarrierRoute } from './temporary-carrier-routes.mjs';

const PUBLIC_BOOTSTRAP = new Set([
  'POST /api/device-auth/challenges',
  'POST /api/device-auth/verify',
  'POST /api/auth/google/token',
  'GET /api/auth/google/status',
]);
const BLOCKED_PREFIXES = [
  '/api/install',
];

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function trustedDeviceToken(req) {
  const authorization = trimString(req.headers?.authorization);
  if (!authorization.startsWith('Bearer ')) return '';
  const token = trimString(authorization.slice(7));
  return /^(?:rda|rdt|rdp)_[a-f0-9]{64}$/.test(token) ? token : '';
}

function browserPermissions(req) {
  if (trimString(req.headers?.['x-ragent-browser-principal']) !== 'browser') return null;
  return new Set(trimString(req.headers?.['x-ragent-browser-permissions']).split(',').map((value) => value.trim()).filter(Boolean));
}

export function createConnectivityPolicyEngine({
  instanceId = '',
  temporaryDevice = null,
  temporaryIngressReady = false,
  // v1 share and v2 full-control use different URL grammars. The P2P
  // loopback proxy receives the parser from the carrier it started.
  temporaryRoute = temporaryCarrierRoute,
} = {}) {
  return {
    decide(req) {
      // Temporary carriers must not inherit bearer, browser or public account-bootstrap authority.
      // The centralized temporary resource policy must replace this explicit closed gate before release.
      if (temporaryDevice) {
        const route = temporaryIngressReady && typeof temporaryRoute === 'function'
          ? temporaryRoute(req.method, req.url) : null;
        if (route && route.instanceId === temporaryDevice.instanceId)
          return { kind: 'temporary_authenticated', scope: route.operation || route.action, principalKind: 'temporary_device' };
        return { kind: 'blocked', statusCode: 403, reason: 'temporary_business_not_ready' };
      }
      const url = new URL(req.url || '/', 'http://connectivity.local');
      const route = `${req.method || 'GET'} ${url.pathname}`;

      if (url.pathname === '/connectivity-health' && req.method === 'GET') {
        return { kind: 'local_health' };
      }

      const permissions = browserPermissions(req);
      if (permissions) {
        const principal = {
          accountId: trimString(req.headers?.['x-ragent-browser-account-id']),
          instanceId: trimString(req.headers?.['x-ragent-browser-instance-id']),
          clientId: trimString(req.headers?.['x-ragent-browser-client-id']),
          connectionId: trimString(req.headers?.['x-ragent-browser-connection-id']),
          grantJti: trimString(req.headers?.['x-ragent-browser-grant-jti']),
        };
        if (Object.values(principal).some((value) => !value)
          || (instanceId && principal.instanceId !== instanceId)) {
          return { kind: 'blocked', statusCode: 403, reason: 'browser_principal_invalid' };
        }
        if (req.method === 'GET' && url.pathname === '/healthz'
          && permissions.has('remote.read.health')) {
          return {
            kind: 'authenticated',
            principalKind: 'browser',
            ...principal,
            scope: 'remote.read.health',
          };
        }
        return { kind: 'blocked', statusCode: 403, reason: 'browser_permission_denied' };
      }

      if (PUBLIC_BOOTSTRAP.has(route)) {
        return { kind: 'public_bootstrap' };
      }

      if (BLOCKED_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
        return { kind: 'blocked', statusCode: 403 };
      }

      if (url.pathname === '/api/device-pairing/invitations'
        || /^\/api\/device-pairing\/devices\/[^/]+\/revoke$/.test(url.pathname)
        || url.pathname.startsWith('/api/onboarding/')) {
        return { kind: 'blocked', statusCode: 403 };
      }

      if (!trustedDeviceToken(req)) {
        return { kind: 'unauthorized', statusCode: 401 };
      }

      return { kind: 'authenticated', scope: 'device-access' };
    },
  };
}

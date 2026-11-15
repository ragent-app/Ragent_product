const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackAddress(address) {
  const value = typeof address === 'string' ? address.trim().toLowerCase() : '';
  if (LOOPBACK_ADDRESSES.has(value)) return true;
  return value.startsWith('::ffff:') && value.slice('::ffff:'.length) === '127.0.0.1';
}

export function resolveChatBindHost({ platform = process.platform, requestedHost = '' } = {}) {
  // The Windows desktop surface is intentionally local-only in A0. Do not let
  // a copied Linux environment file turn it into a network listener.
  if (platform === 'win32') return '127.0.0.1';
  return typeof requestedHost === 'string' && requestedHost.trim()
    ? requestedHost.trim()
    : '127.0.0.1';
}

export function resolveSecureCookies({
  platform = process.platform,
  requested = process.env.SECURE_COOKIES,
} = {}) {
  const value = typeof requested === 'string' ? requested.trim() : '';
  if (value) return value !== '0';
  // Windows A0 is forced to a loopback-only HTTP listener. The local HTML
  // request creates the owner session used by subsequent API requests, so a
  // default Secure cookie would be rejected by http://127.0.0.1.
  return platform !== 'win32';
}

// tunnel-client 转发的请求在 TCP 层同样表现为 127.0.0.1（最后一跳是本机
// tunnel-client），远程浏览器会被误判成"本机浏览器"。tunnel-client 给每个
// 转发请求统一盖上该标记并覆盖上游带来的同名头；本机直连则没有这个头。
export const TUNNEL_MARKER_HEADER = 'x-ragent-tunnel';

export function isTunneledRequest(req) {
  const value = req?.headers?.[TUNNEL_MARKER_HEADER];
  return typeof value === 'string' && value.trim() !== '';
}

export function shouldUseLocalWebAuth({
  enabled = true,
  remoteAddress = '',
  url = '/',
  accept = '',
  viaTunnel = false,
} = {}) {
  if (viaTunnel) return false;
  if (enabled !== true || !isLoopbackAddress(remoteAddress)) return false;
  if (typeof url === 'string' && url.split('?', 1)[0].startsWith('/api/')) return false;
  return typeof accept === 'string' && accept.toLowerCase().includes('text/html');
}

// Resolve a local outbound proxy for provider Runs.
//
// The control plane normally runs as a system user, while desktop proxy
// clients (mihomo/Clash and similar) run as the logged-in user.  Their proxy
// environment is therefore not present in the systemd service environment.
// Prefer an explicitly configured proxy, then enumerate current loopback
// listeners from procfs and verify the protocol handshake.  An arbitrary open
// TCP port is never treated as a proxy, and no vendor-specific port is baked
// into the default path.

import { createConnection } from 'net';
import { readFile } from 'fs/promises';

export const LOCAL_NO_PROXY = ['127.0.0.1', 'localhost', '::1'];

const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
];
const proxyDiscoveryCache = new Map();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstNonEmpty(...values) {
  return values.map(trimString).find(Boolean) || '';
}

function normalizeProxyUrl(value) {
  let raw = trimString(value);
  if (!raw) return '';
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) raw = `http://${raw}`;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) return '';
    if (!parsed.hostname || parsed.username || parsed.password) return '';
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function mergeNoProxy(value) {
  const entries = trimString(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const localHost of LOCAL_NO_PROXY) {
    if (!entries.includes(localHost)) entries.push(localHost);
  }
  return entries.join(',');
}

function buildProxyEnvironment(url, source = {}) {
  const normalized = normalizeProxyUrl(url);
  if (!normalized) return {};
  const http = normalizeProxyUrl(firstNonEmpty(source.HTTP_PROXY, source.http_proxy)) || normalized;
  const https = normalizeProxyUrl(firstNonEmpty(source.HTTPS_PROXY, source.https_proxy)) || normalized;
  const all = normalizeProxyUrl(firstNonEmpty(source.ALL_PROXY, source.all_proxy)) || normalized;
  const noProxy = mergeNoProxy(firstNonEmpty(source.NO_PROXY, source.no_proxy));
  return {
    HTTP_PROXY: http,
    HTTPS_PROXY: https,
    ALL_PROXY: all,
    NO_PROXY: noProxy,
    http_proxy: http,
    https_proxy: https,
    all_proxy: all,
    no_proxy: noProxy,
  };
}

export function getConfiguredProxyEnvironment(environment = {}) {
  const configured = firstNonEmpty(
    environment.HTTP_PROXY,
    environment.HTTPS_PROXY,
    environment.ALL_PROXY,
    environment.http_proxy,
    environment.https_proxy,
    environment.all_proxy,
  );
  return configured ? buildProxyEnvironment(configured, environment) : {};
}

export function parseProxyPorts(value, fallback = []) {
  const values = String(value || '')
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
  return [...new Set(values.length > 0 ? values : fallback)];
}

export async function readListeningPorts({
  readFileImpl = readFile,
  procFiles = ['/proc/net/tcp', '/proc/net/tcp6'],
} = {}) {
  const ports = new Set();
  for (const procFile of procFiles) {
    let contents;
    try {
      contents = await readFileImpl(procFile, 'utf8');
    } catch {
      continue;
    }
    for (const line of String(contents).split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4 || fields[3] !== '0A') continue;
      const localAddress = fields[1] || '';
      const portHex = localAddress.slice(localAddress.lastIndexOf(':') + 1);
      const port = Number.parseInt(portHex, 16);
      if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

export function probeHttpProxy(port, {
  host = '127.0.0.1',
  timeoutMs = 350,
  connectImpl = createConnection,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    let socket;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { socket?.destroy(); } catch {}
      resolve(ok);
    };
    try {
      socket = connectImpl({ host, port });
      socket.setTimeout?.(timeoutMs, () => finish(false));
      socket.once('connect', () => {
        socket.write(`CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com\r\n\r\n`);
      });
      socket.on('data', (chunk) => {
        buffer += String(chunk || '');
        if (buffer.length > 8192) return finish(false);
        const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s+([^\r\n]*)/i.exec(buffer);
        if (match) {
          const status = Number.parseInt(match[1], 10);
          const reason = match[2].trim();
          // A normal HTTP service can return 200 to CONNECT as an ordinary
          // request. Only accept the response phrase used for an established
          // tunnel, otherwise a dashboard/API port is misclassified as a
          // proxy and breaks every provider Run that inherits the result.
          finish(status === 200 && /connection\s+established|tunnel\s+established/i.test(reason));
        }
      });
      socket.once('error', () => finish(false));
      socket.once('close', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

function probeSocksProxy(port, {
  host = '127.0.0.1',
  timeoutMs = 350,
  connectImpl = createConnection,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    let socket;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { socket?.destroy(); } catch {}
      resolve(ok);
    };
    try {
      socket = connectImpl({ host, port });
      socket.setTimeout?.(timeoutMs, () => finish(false));
      socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])));
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        if (buffer.length >= 2) finish(buffer[0] === 5 && buffer[1] === 0);
      });
      socket.once('error', () => finish(false));
      socket.once('close', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

export async function discoverLocalProxy({
  environment = process.env,
  connectImpl = createConnection,
  timeoutMs = 350,
  readListeningPortsImpl = readListeningPorts,
  probeHttpImpl = probeHttpProxy,
  probeSocksImpl = probeSocksProxy,
} = {}) {
  const host = trimString(environment.RAGENT_PROXY_HOST) || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return '';
  const configuredPorts = environment.RAGENT_PROXY_PORTS;
  const listeningPorts = await readListeningPortsImpl();
  const ports = parseProxyPorts(configuredPorts, listeningPorts).slice(0, 256);
  const httpPorts = ports;
  for (const port of httpPorts) {
    if (await probeHttpImpl(port, { host, timeoutMs, connectImpl })) return `http://${host}:${port}`;
  }
  for (const port of ports) {
    if (await probeSocksImpl(port, { host, timeoutMs, connectImpl })) return `socks5h://${host}:${port}`;
  }
  return '';
}

export async function resolveRunnerProxyEnvironment(environment = process.env, {
  discover = environment === process.env,
  connectImpl = createConnection,
  timeoutMs = 350,
} = {}) {
  const configured = getConfiguredProxyEnvironment(environment);
  if (Object.keys(configured).length > 0) return configured;
  if (!discover || trimString(environment.RAGENT_AUTO_PROXY_DISCOVERY) === '0') return {};
  const cacheKey = `${trimString(environment.RAGENT_PROXY_HOST) || '127.0.0.1'}|${trimString(environment.RAGENT_PROXY_PORTS) || 'defaults'}`;
  if (!proxyDiscoveryCache.has(cacheKey)) {
    proxyDiscoveryCache.set(cacheKey, discoverLocalProxy({ environment, connectImpl, timeoutMs }));
  }
  const discovered = await proxyDiscoveryCache.get(cacheKey);
  return discovered ? buildProxyEnvironment(discovered, environment) : {};
}

export const NETWORK_PROXY_ENV_KEYS = PROXY_ENV_KEYS;

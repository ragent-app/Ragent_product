import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  discoverLocalProxy,
  getConfiguredProxyEnvironment,
  parseProxyPorts,
  probeHttpProxy,
  readListeningPorts,
  resolveRunnerProxyEnvironment,
} from '../lib/network-proxy.mjs';

assert.deepEqual(parseProxyPorts('7890, 7891,7890', []), [7890, 7891]);
assert.deepEqual(parseProxyPorts('', [3128, 7890]), [3128, 7890]);

const configured = getConfiguredProxyEnvironment({
  HTTPS_PROXY: 'http://127.0.0.1:9000',
});
assert.equal(configured.HTTP_PROXY, 'http://127.0.0.1:9000');
assert.equal(configured.HTTPS_PROXY, 'http://127.0.0.1:9000');
assert.match(configured.NO_PROXY, /127\.0\.0\.1/);
assert.deepEqual(
  getConfiguredProxyEnvironment({ HTTP_PROXY: 'http://user:secret@127.0.0.1:9000' }),
  {},
  'proxy credentials must not be copied into a Run environment/argv path',
);

const procText = [
  '  sl  local_address rem_address   st',
  '   0: 0100007F:1EDC 00000000:0000 0A',
  '   1: 00000000:1F90 00000000:0000 0A',
  '   2: 0100007F:0016 00000000:0000 01',
].join('\n');
assert.deepEqual(
  await readListeningPorts({
    procFiles: ['/proc/net/tcp'],
    readFileImpl: async () => procText,
  }),
  [7900, 8080],
  'only LISTEN sockets from procfs should be enumerated',
);

const discovered = await discoverLocalProxy({
  environment: { RAGENT_PROXY_PORTS: '9000,9001' },
  readListeningPortsImpl: async () => [9000, 9001],
  probeHttpImpl: async (port) => port === 9001,
  probeSocksImpl: async () => false,
});
assert.equal(discovered, 'http://127.0.0.1:9001');

function fakeHttpSocket(response) {
  const socket = new EventEmitter();
  socket.setTimeout = () => {};
  socket.write = () => queueMicrotask(() => socket.emit('data', response));
  socket.destroy = () => {};
  queueMicrotask(() => socket.emit('connect'));
  return socket;
}

assert.equal(
  await probeHttpProxy(4010, {
    connectImpl: () => fakeHttpSocket('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n'),
  }),
  false,
  'ordinary HTTP 200 responses must not be treated as CONNECT proxies',
);
assert.equal(
  await probeHttpProxy(7890, {
    connectImpl: () => fakeHttpSocket('HTTP/1.1 200 Connection established\r\n\r\n'),
  }),
  true,
  'an established CONNECT tunnel should be recognized as an HTTP proxy',
);

const resolved = await resolveRunnerProxyEnvironment(
  { HTTP_PROXY: 'http://127.0.0.1:9010' },
  { discover: false },
);
assert.equal(resolved.HTTPS_PROXY, 'http://127.0.0.1:9010');

console.log('test-network-proxy: ok');

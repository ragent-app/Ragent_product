#!/usr/bin/env node
import assert from 'assert/strict';
import {
  appendQueryMarker,
  median,
  parseCloudflareTrace,
  parseCloudflaredTunnelInfo,
} from '../lib/tunnel-diagnostics.mjs';

assert.equal(
  appendQueryMarker('/api/sessions?view=refs', '_perf', 'abc123'),
  '/api/sessions?view=refs&_perf=abc123'
);

assert.equal(
  appendQueryMarker('https://example.com/chat/ui.js', '_perf', 'abc123'),
  'https://example.com/chat/ui.js?_perf=abc123'
);

assert.deepEqual(parseCloudflareTrace(`fl=abc123
h=ragent.example.com
ip=1.2.3.4
colo=LAX
loc=CN
`), {
  fl: 'abc123',
  h: 'ragent.example.com',
  ip: '1.2.3.4',
  colo: 'LAX',
  loc: 'CN',
});

assert.equal(median([]), null);
assert.equal(median([5]), 5);
assert.equal(median([1, 10, 3]), 3);
assert.equal(median([1, 10, 3, 7]), 5);

const tunnelInfo = parseCloudflaredTunnelInfo(`NAME:     claude-code-remote
ID:       23d39530-c809-4a4c-b832-1108d7cb0ad6
CREATED:  2026-02-27 10:37:18.348122 +0000 UTC

CONNECTOR ID                         CREATED              ARCHITECTURE VERSION  ORIGIN IP     EDGE
618dde89-0ae1-4d64-824d-6fa7fa8e7518 2026-03-15T15:47:09Z darwin_arm64 2026.2.0 192.0.2.44 2xlax06, 1xlax07, 1xlax10
`);

assert.equal(tunnelInfo.name, 'claude-code-remote');
assert.equal(tunnelInfo.id, '23d39530-c809-4a4c-b832-1108d7cb0ad6');
assert.equal(tunnelInfo.connectors.length, 1);
assert.deepEqual(tunnelInfo.connectors[0], {
  connectorId: '618dde89-0ae1-4d64-824d-6fa7fa8e7518',
  created: '2026-03-15T15:47:09Z',
  architecture: 'darwin_arm64',
  version: '2026.2.0',
  originIp: '192.0.2.44',
  edge: '2xlax06, 1xlax07, 1xlax10',
});

console.log('test-tunnel-diagnostics: ok');


import assert from 'node:assert/strict';
import { normalizeP2PHostIceServers } from '../lib/p2p-host-agent.mjs';

const previous = process.env.RAGENT_P2P_TURN_HOST_RESOLVE;
try {
  process.env.RAGENT_P2P_TURN_HOST_RESOLVE = 'turn.example.test=203.0.113.8';
  const rewrite = (url) => normalizeP2PHostIceServers([{ urls: url, username: 'u', credential: 'p' }])[0];
  assert.deepEqual(rewrite('turn:turn.example.test:3478?transport=udp'), { urls: ['turn:203.0.113.8:3478?transport=udp'], username: 'u', credential: 'p' });
  assert.equal(rewrite('turns:turn.example.test:5349?transport=tcp').urls[0], 'turns:203.0.113.8:5349?transport=tcp');
  assert.equal(rewrite('turn:turn.example.test.evil:3478').urls[0], 'turn:turn.example.test.evil:3478');
  assert.equal(rewrite('stun:turn.example.test:3478').urls[0], 'stun:turn.example.test:3478');
  process.env.RAGENT_P2P_TURN_HOST_RESOLVE = 'turn.example.test=not-an-ip';
  assert.equal(rewrite('turn:turn.example.test:3478').urls[0], 'turn:turn.example.test:3478');
  process.env.RAGENT_P2P_TURN_HOST_RESOLVE = 'turn.example.test=2001:db8::1';
  assert.equal(rewrite('turn:turn.example.test:3478').urls[0], 'turn:[2001:db8::1]:3478');
} finally {
  if (previous === undefined) delete process.env.RAGENT_P2P_TURN_HOST_RESOLVE;
  else process.env.RAGENT_P2P_TURN_HOST_RESOLVE = previous;
}
console.log('test-p2p-host-turn-resolve: 6 assertions passed');

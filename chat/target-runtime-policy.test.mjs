import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTargetRuntimeRequest } from '../lib/target-runtime-policy.mjs';
import { TARGET_RUNTIME_OPERATIONS } from '../lib/target-runtime-contract.mjs';

test('target runtime exposes only the exact local voice operations needed by paired phones', () => {
  const routes = [
    ['GET', '/api/local-voice-settings', 'voice.settings.read'],
    ['PATCH', '/api/local-voice-settings', 'voice.settings.write'],
    ['POST', '/api/local-voice-install', 'voice.install'],
    ['GET', '/api/local-voice-install/d1b1a6b9-54ef-4784-8cb5-ef0fe011f9e7', 'voice.install.read'],
    ['POST', '/api/local-voice-recognition', 'voice.recognition'],
  ];

  for (const [method, path, operation] of routes) {
    assert.deepEqual(classifyTargetRuntimeRequest(method, path), { method, path, operation });
    assert.ok(TARGET_RUNTIME_OPERATIONS.includes(operation));
  }
});

test('target runtime rejects other methods and neighboring local voice routes', () => {
  for (const [method, path] of [
    ['POST', '/api/local-voice-settings'],
    ['PUT', '/api/local-voice-settings'],
    ['GET', '/api/local-voice-install'],
    ['PATCH', '/api/local-voice-install'],
    ['POST', '/api/local-voice-install/d1b1a6b9-54ef-4784-8cb5-ef0fe011f9e7'],
    ['GET', '/api/local-voice-install/not-an-operation-id'],
    ['GET', '/api/local-voice-recognition'],
    ['POST', '/api/local-voice-recognition/anything'],
  ]) {
    assert.equal(classifyTargetRuntimeRequest(method, path), null, `${method} ${path}`);
  }
});

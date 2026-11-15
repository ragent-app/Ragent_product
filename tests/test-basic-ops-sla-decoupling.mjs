#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function unitValue(unitText, key) {
  const match = unitText.match(new RegExp(`^${key}=(.+)$`, 'm'));
  return match ? match[1].trim() : '';
}

function assertNoRequires(unitText, unitName, forbiddenUnit) {
  for (const line of unitText.split(/\r?\n/)) {
    if (!line.startsWith('Requires=')) continue;
    assert.equal(
      line.includes(forbiddenUnit),
      false,
      `${unitName} must not hard-require ${forbiddenUnit}; basic chat must start without privileged executor paths`,
    );
  }
}

const chatServer = read('chat-server.mjs');
const ragentUnit = read('packaging/deb/ragent.service');
const runnerSupervisorService = read('packaging/deb/ragent-runner-supervisor.service');
const privilegedUnit = read('packaging/deb/ragent-privileged-executor.service');

for (const forbidden of [
  'ragent-maintenance-broker.service',
  'ragent-maintenance-control.service',
  'ragent-privileged-executor.service',
]) {
  assertNoRequires(ragentUnit, 'ragent.service', forbidden);
}

assert.match(ragentUnit, /^Requires=ragent-runner-supervisor\.service$/m);
assert.match(ragentUnit, /^Restart=always$/m);
assert.doesNotMatch(ragentUnit, /^ConditionPathExists=.*privileged/m);
assert.equal(unitValue(privilegedUnit, 'Restart'), 'on-failure');
assert.doesNotMatch(ragentUnit, /ragent-maintenance|maintenance-control/);
assert.doesNotMatch(runnerSupervisorService, /ragent-maintenance|maintenance-control/);

assert.match(chatServer, /req\.method === 'GET' && req\.url === '\/healthz'/);
assert.match(chatServer, /writeHealthz\(res\);\s*return;/);
assert.match(chatServer, /requestLog\.run\(\(\) => handleRequest\(req, res\)\)\.catch/);
assert.doesNotMatch(chatServer, /maintenance-control-service\.mjs/);
assert.doesNotMatch(chatServer, /maintenance-broker\.mjs/);
assert.doesNotMatch(chatServer, /privileged-executor\.mjs/);

console.log('test-basic-ops-sla-decoupling: ok');

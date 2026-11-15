#!/usr/bin/env node
/**
 * Unit contract for the PowerShell-owned Windows named-pipe executor server.
 * The real-Windows behavior (real pipe, OS peer facts, gate verdict relay) is
 * covered by the live test on a Windows host. These checks mock spawn/connect
 * to lock the orchestration contract: fixed-argv invocation, gate verdict
 * relay ordering, and fail-closed paths.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  WINDOWS_EXECUTOR_POWERSHELL,
  buildWindowsExecutorServerInvocation,
  runWindowsExecutorRequest,
  spawnWindowsExecutorServerProcess,
} from '../chat/windows-executor-server.mjs';

let passed = 0;
function check(label, value) {
  assert.ok(value, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.deepEqual(actual, expected, `failed: ${label}`);
  passed += 1;
}

const GOOD_FACTS = {
  platform: 'win32',
  transport: 'named-pipe',
  authenticated: true,
  sameUser: true,
  integrity: 'high',
  sid: 'S-1-5-21-111-222-333-1001',
};

function makeChild({ stdoutLine }) {
  const child = {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { write: () => {}, end: () => {} },
    kill: () => {},
    once: () => {},
  };
  if (stdoutLine != null) {
    setImmediate(() => child.stdout.emit('data', `${stdoutLine}\n`));
  }
  return child;
}

function makeClient({ onWrite }) {
  const client = new EventEmitter();
  client.destroyed = false;
  client.write = (data) => { if (onWrite) onWrite(data); };
  client.destroy = () => { client.destroyed = true; };
  return client;
}

// ── invocation boundary ────────────────────────────────────────────────────────

const inv = buildWindowsExecutorServerInvocation({ pipeName: 'ragent-exec-test' });
eq('server uses the absolute system PowerShell', inv.file, WINDOWS_EXECUTOR_POWERSHELL);
check('server args are fixed prefix + one encoded command', inv.args.length === 5 && inv.args[4].length > 0);
eq('server carries the pipe name as an env value', inv.env.RAGENT_EXECUTOR_PIPE, 'ragent-exec-test');
check('server env is allowlisted', inv.env.LANG === 'C' && inv.env.PATH.includes('System32'));
check('server script embeds the native interop', inv.args[4].length > 1000);

// ── production lifecycle boundary ───────────────────────────────────────────

const managedSpawnCalls = [];
const managedChild = makeChild({});
const managedResult = await spawnWindowsExecutorServerProcess({
  invocation: inv,
  spawnManagedImpl: async (spec, options) => {
    managedSpawnCalls.push({ spec, options });
    return managedChild;
  },
});
check('default executor server launch uses the managed facade', managedResult === managedChild);
eq('managed executor server keeps the fixed PowerShell file', managedSpawnCalls[0].spec.file, WINDOWS_EXECUTOR_POWERSHELL);
eq('managed executor server keeps the encoded argv', managedSpawnCalls[0].spec.args, inv.args);
eq('managed executor server keeps the allowlisted environment', managedSpawnCalls[0].spec.env, inv.env);
eq('managed executor server does not enable a shell', managedSpawnCalls[0].spec.shell, false);
eq('managed executor server requests all stdio pipes', managedSpawnCalls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
eq('managed executor server closes with its controller', managedSpawnCalls[0].options.preserveOnControllerExit, false);

// ── happy path: gate admits, verdict relayed after gate ───────────────────────

let relayOrder = [];
const happyClient = makeClient({
  onWrite: () => {
    relayOrder.push('client-write');
    // Simulate the PowerShell server relaying the verdict back after reading
    // the stdin verdict.
    setImmediate(() => happyClient.emit('data', `${JSON.stringify({ ok: true, code: '', peer: GOOD_FACTS.sid })}\n`));
  },
});
const happyChild = makeChild({
  stdoutLine: JSON.stringify({ ok: true, facts: GOOD_FACTS, request: 'ping', clientPid: 4242 }),
});
let stdinWrites = [];
happyChild.stdin.write = (data) => { relayOrder.push('stdin-verdict'); stdinWrites.push(data); };

const happy = await runWindowsExecutorRequest({
  pipeName: 'ragent-exec-happy',
  request: 'ping',
  expectedSid: GOOD_FACTS.sid,
  spawn: () => happyChild,
  connectImpl: async () => happyClient,
});
check('happy path gate admits', happy.ok === true);
eq('happy path relays the verdict to the client', happy.clientResponse, JSON.stringify({ ok: true, code: '', peer: GOOD_FACTS.sid }));
eq('verdict relayed after the gate decision', relayOrder[relayOrder.length - 1], 'stdin-verdict');
check('gate verdict written to server stdin', stdinWrites.length === 1 && stdinWrites[0].includes('"ok":true'));

// ── SID mismatch: gate DENYs, verdict relayed to client ───────────────────────

const denyClient = makeClient({
  onWrite: () => setImmediate(() => denyClient.emit('data', `${JSON.stringify({ ok: false, code: 'WINDOWS_PEER_IDENTITY_MISMATCH', error: 'Windows peer SID does not match' })}\n`)),
});
const denyChild = makeChild({ stdoutLine: JSON.stringify({ ok: true, facts: GOOD_FACTS, request: 'ping', clientPid: 4242 }) });
const deny = await runWindowsExecutorRequest({
  pipeName: 'ragent-exec-deny',
  request: 'ping',
  expectedSid: 'S-1-5-21-999-999-999-999',
  spawn: () => denyChild,
  connectImpl: async () => denyClient,
});
check('SID mismatch DENYs', deny.ok === false && deny.code === 'WINDOWS_PEER_IDENTITY_MISMATCH');

// ── fail closed: server ok:false payload ───────────────────────────────────────

const badChild = makeChild({
  stdoutLine: JSON.stringify({ ok: false, code: 'WINDOWS_EXECUTOR_TRANSPORT_FAILED', error: 'connection timed out' }),
});
await assert.rejects(
  () => runWindowsExecutorRequest({
    pipeName: 'ragent-exec-bad',
    request: 'ping',
    expectedSid: GOOD_FACTS.sid,
    spawn: () => badChild,
    connectImpl: async () => makeClient({}),
  }),
  (error) => error?.code === 'WINDOWS_EXECUTOR_TRANSPORT_FAILED' && /connection timed out/.test(error?.message),
  'server ok:false payload must fail closed',
);

// ── fail closed: invalid pipe name ─────────────────────────────────────────────

await assert.rejects(
  () => runWindowsExecutorRequest({ pipeName: '../bad/pipe;rm', request: 'ping', expectedSid: '' }),
  /valid executor pipe name/,
  'invalid pipe name must be rejected before any spawn',
);

// ── fail closed: malformed server output ───────────────────────────────────────

const malformedChild = makeChild({ stdoutLine: 'not-json at all' });
await assert.rejects(
  () => runWindowsExecutorRequest({
    pipeName: 'ragent-exec-malformed',
    request: 'ping',
    expectedSid: GOOD_FACTS.sid,
    spawn: () => malformedChild,
    connectImpl: async () => makeClient({}),
  }),
  (error) => /Windows executor server produced no output|malformed|exited early/.test(error?.message || ''),
  'malformed server output must fail closed',
);

console.log(`windows-executor-server: ${passed} checks passed`);

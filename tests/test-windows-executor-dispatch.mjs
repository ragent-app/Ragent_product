#!/usr/bin/env node
/**
 * Windows named-pipe executor dispatch-path tests (handoff §7, §10.3-2/3).
 *
 * The privileged daemon deliberately keeps its Windows route hard-disabled
 * until the unified Phase 2B gate and a real connection-bound fact source are
 * wired. These checks prove that test options, peer claims, and resolver
 * injections cannot revive the old capability/revalidation path. The direct
 * Windows peer and dispatch modules have their own contract suites.
 *
 * On a real win32 host the resolver would be bound to the accepted named-pipe
 * connection (resolveClientPeerFactsForConnection). Here the resolver is
 * injected so the deterministic Linux dispatch path can be tested end-to-end.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compileSemanticOperations } from '../chat/semantic-compiler.mjs';
import { evaluateSemanticOperation } from '../chat/semantic-policy.mjs';
import { resolveSemanticContext } from '../chat/semantic-resolver.mjs';
import {
  SEMANTIC_ADAPTER_WINGET_INSTALL_V1,
  createSemanticCapability,
  signSemanticCapability,
} from '../chat/semantic-capability.mjs';

let passed = 0;
function eq(label, actual, expected) {
  assert.equal(actual, expected, `failed: ${label}`);
  passed += 1;
}

const tmpDir = await mkdtemp(join(tmpdir(), 'ragent-exec-dispatch-'));
const EXPECTED_SID = 'S-1-5-21-111-222-333-1001';
const GOOD_FACTS = {
  platform: 'win32',
  transport: 'named-pipe',
  authenticated: true,
  sameUser: true,
  integrity: 'high',
  sid: EXPECTED_SID,
};

// Environment must be set before the executor module is imported (module-level
// constants read env at import time).
process.env.RAGENT_PRIVILEGED_EXECUTOR_ALLOW_UNPRIVILEGED_TEST = '1';
process.env.RAGENT_PRIVILEGED_EXECUTOR_SKIP_RUNNER_LIVENESS = '1';
process.env.RAGENT_WINDOWS_PEER_SID = EXPECTED_SID;
process.env.RAGENT_PRIVILEGED_EXECUTOR_SOCKET = join(tmpDir, 'sock');
process.env.RAGENT_PRIVILEGED_EXECUTOR_AUDIT_FILE = join(tmpDir, 'audit.jsonl');
process.env.RAGENT_PRIVILEGED_SIGNING_KEYS_FILE = join(tmpDir, 'keys.json');
process.env.RAGENT_SERVICE_USER_FILE = join(tmpDir, 'service-user');
await writeFile(join(tmpDir, 'service-user'), 'ragent\n');

const keys = generateKeyPairSync('ed25519');
const kid = 'kid_win_dispatch';
await writeFile(join(tmpDir, 'keys.json'), JSON.stringify({
  current: {
    kid,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  },
  previous: null,
}, null, 2));

const { handleRequest } = await import('../scripts/privileged-executor.mjs');

function baseRequest(extra = {}) {
  const token = Math.random().toString(36).slice(2, 10);
  return {
    action: 'semantic-exec',
    id: `preq_${token}`,
    capability: {
      adapter: 'windows-winget-install/v1',
      nonce: `n_${token}`,
      capabilityId: 'cap_dispatch',
      operations: [{}],
    },
    ...extra,
  };
}
function winContext(resolvePeerFacts) {
  return { windowsAdapterEnabled: true, platform: 'win32', resolvePeerFacts };
}

// ── production Windows route remains hard-disabled ────────────────────────────
{
  let resolverCalled = false;
  const resp = await handleRequest(baseRequest(), {}, winContext(async () => {
    resolverCalled = true;
    return GOOD_FACTS;
  }));
  eq('Windows route is hard-disabled before peer resolution', resp.code, 'SEMANTIC_WINDOWS_ADAPTER_DISABLED');
  eq('disabled route never calls the injected resolver', resolverCalled, false);
}

// ── adversarial: peer identity facts all fail closed ──
{
  const resp = await handleRequest(baseRequest(), {}, winContext(async () => ({ ...GOOD_FACTS, sid: 'S-1-5-21-999' })));
  eq('forged SID cannot revive the disabled route', resp.code, 'SEMANTIC_WINDOWS_ADAPTER_DISABLED');
}
{
  const resp = await handleRequest(baseRequest(), {}, winContext(async () => ({ ...GOOD_FACTS, integrity: 'medium' })));
  eq('integrity claim cannot revive the disabled route', resp.code, 'SEMANTIC_WINDOWS_ADAPTER_DISABLED');
}
{
  const resp = await handleRequest(baseRequest(), {}, winContext(async () => ({ ...GOOD_FACTS, sameUser: false })));
  eq('same-user claim cannot revive the disabled route', resp.code, 'SEMANTIC_WINDOWS_ADAPTER_DISABLED');
}
{
  const resp = await handleRequest(baseRequest(), {}, winContext(async () => ({ ...GOOD_FACTS, authenticated: false })));
  eq('authentication claim cannot revive the disabled route', resp.code, 'SEMANTIC_WINDOWS_ADAPTER_DISABLED');
}
{
  const resp = await handleRequest(baseRequest(), {}, winContext(async () => ({ ...GOOD_FACTS, transport: 'unix' })));
  eq('transport claim cannot revive the disabled route', resp.code, 'SEMANTIC_WINDOWS_ADAPTER_DISABLED');
}

// ── adversarial: caller declares perfect facts in request.peer, trusted source disagrees → DENY ──
{
  const resp = await handleRequest(
    baseRequest({ peer: GOOD_FACTS }), // caller-declared — ignored by the gate
    {},
    winContext(async () => ({ ...GOOD_FACTS, sid: 'S-1-5-21-ATTACKER' })),
  );
  eq('caller peer facts cannot revive the disabled route', resp.code, 'SEMANTIC_WINDOWS_ADAPTER_DISABLED');
}

// ── fail closed: resolver missing / resolver throws ──
{
  const resp = await handleRequest(baseRequest(), {}, { windowsAdapterEnabled: true, platform: 'win32', resolvePeerFacts: undefined });
  eq('missing resolver does not revive the disabled route', resp.code, 'SEMANTIC_WINDOWS_ADAPTER_DISABLED');
}
{
  const resp = await handleRequest(baseRequest(), {}, winContext(async () => {
    const error = new Error('named pipe peer resolution failed');
    error.code = 'WINDOWS_PIPE_PEER_FAILED';
    throw error;
  }));
  eq('resolver failure does not revive the disabled route', resp.code, 'SEMANTIC_WINDOWS_ADAPTER_DISABLED');
}

// ── Linux default DENY preserved ──
{
  const resp = await handleRequest(baseRequest(), {}, {});
  eq('production Linux default: adapter disabled', resp.code, 'SEMANTIC_WINDOWS_ADAPTER_DISABLED');
}
{
  const resp = await handleRequest(baseRequest(), {}, { windowsAdapterEnabled: true });
  eq('explicit enable option cannot revive the disabled route', resp.code, 'SEMANTIC_WINDOWS_ADAPTER_DISABLED');
}

// ── adversarial: nonce replay DENY on the dispatch path ──
// Build a real signed winget capability through the same server pipeline the
// executor consumes, then replay its one-shot nonce. The first use passes the
// peer gate and signature verification, reserves the nonce, then fails target
// revalidation on this Linux host (winget absent) — the nonce is consumed
// regardless, so the replay must DENY.
{
  const binding = { sessionId: 's_dispatch', runId: 'r_dispatch', turnId: 't_dispatch', requestKey: 'req_dispatch', executionClass: 'host' };
  const trustedContext = { cwd: 'C:\\project', projectRoot: 'C:\\project', home: 'C:\\Users\\owner', platform: 'win32' };
  const compile = (rawCommand) => compileSemanticOperations({ request: { ...binding, rawCommand }, trustedContext });
  const packageOperation = compile('winget install --id Git.Git --exact --source winget').operations[0];
  const packageResolution = await resolveSemanticContext({
    operation: packageOperation,
    options: {
      trustedContext,
      windowsFactsProvider: {
        name: 'winget-fixture',
        async packageFacts(query) {
          return {
            manager: 'winget',
            source: 'winget',
            sourceTrust: 'configured',
            repositories: [{ id: 'winget', trust: 'configured' }],
            packages: query.packages.map((name) => ({ name, requestedVersion: '', availableVersion: '2.0' })),
          };
        },
      },
    },
  });
  const packageDecision = evaluateSemanticOperation(packageOperation, packageResolution);
  eq('fixture decision is ASK', packageDecision.decision, 'ASK');
  const unsigned = createSemanticCapability({
    selectedDecisions: [packageDecision],
    adapter: SEMANTIC_ADAPTER_WINGET_INSTALL_V1,
    sessionId: 's_dispatch', runId: 'r_dispatch', turnId: 't_dispatch', credentialId: 'cred_dispatch', kid, now: Date.now(),
  });
  const signedCapability = signSemanticCapability(unsigned, keys.privateKey);
  const replayRequest = { action: 'semantic-exec', id: 'preq_replay', capability: signedCapability };
  const first = await handleRequest(replayRequest, {}, winContext(async () => GOOD_FACTS));
  eq('first use remains disabled before capability verification', first.code, 'SEMANTIC_WINDOWS_ADAPTER_DISABLED');
  const replay = await handleRequest(replayRequest, {}, winContext(async () => GOOD_FACTS));
  eq('replayed request remains disabled before nonce handling', replay.code, 'SEMANTIC_WINDOWS_ADAPTER_DISABLED');
}

await rm(tmpDir, { recursive: true, force: true });
console.log(`windows-executor-dispatch: ${passed} checks passed`);

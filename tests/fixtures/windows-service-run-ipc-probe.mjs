// Credential-free cross-service QA. Mailboxes are role-owned, peer-read-only;
// neither their contents nor the synthetic capability are product authority.
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRestrictedRunIpcGrant } from '../../chat/restricted-run-ipc.mjs';
import { endpoint } from '../helpers/windows-run-pipe-fixture.mjs';
export const scenarios = ['success', 'capability', 'cross-run', 'server-pin', 'client-pin'];
function refusal(code, role, scenario) {
  const exact = role === 'executor' ? { capability: 'IPC_CAPABILITY_DENIED', 'cross-run': 'IPC_BINDING_MISMATCH', 'client-pin': 'IPC_PEER_PIN_MISMATCH' }
    : { 'server-pin': 'IPC_PEER_PIN_MISMATCH' };
  if (exact[scenario]) assert.equal(code, exact[scenario]);
  else assert.ok(['IPC_PEER_DISCONNECTED', 'IPC_TRANSPORT_FAILED', 'IPC_PROCESS_UNAVAILABLE', 'IPC_TOKEN_UNAVAILABLE'].includes(code), code);
}
export async function serviceRunIpc(root, role, spec) {
  const report = { pass: false, role, round: spec.ipcRound, providerUsed: false, cases: [] };
  const mine = join(root, 'handoff', role), peer = join(root, 'handoff', role === 'control' ? 'executor' : 'control');
  async function put(name, value) {
    await writeFile(join(mine, name + '.tmp'), JSON.stringify(value), { flag: 'wx' });
    await rename(join(mine, name + '.tmp'), join(mine, name));
  }
  async function get(name) {
    const until = Date.now() + 7000;
    while (Date.now() < until) {
      try {
        const path = join(peer, name), facts = await lstat(path);
        assert.ok(facts.isFile() && !facts.isSymbolicLink() && facts.nlink === 1 && facts.size <= 98304);
        return JSON.parse(await readFile(path, 'utf8'));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(done => setTimeout(done, 20));
    }
    throw new Error('QA_MAILBOX_TIMEOUT:' + name);
  }
  try {
    assert.ok([1, 2].includes(spec.ipcRound));
    for (const scenario of scenarios) {
      const prefix = `r${spec.ipcRound}-${scenario}-`, success = scenario === 'success';
      const current = { scenario, pass: false, dispatched: 0 };
      report.cases.push(current);
      const bridge = endpoint(join(root, 'runtime/RunPipeCandidate.exe'), role === 'executor' ? 'server' : 'client');
      try {
        if (role === 'executor') {
          const lease = { version: 1, leaseId: randomUUID(), runId: 'run_' + randomBytes(16).toString('hex'),
            requestId: 'service-ipc-' + spec.caseId + '-' + prefix,
            grantId: 'rtg_' + randomBytes(24).toString('base64url'), authorityHash: randomBytes(32).toString('hex'),
            expiresAtUnixMs: Date.now() + 15000 };
          const grant = createRestrictedRunIpcGrant({ instanceId: 'service-ipc-' + spec.caseId, lease });
          const frame = grant.frame('Sum the amount column in workspace/input.csv by name.');
          const policy = { pipeName: 'ragent-run-candidate-' + randomBytes(16).toString('hex'),
            expiresAtUnixMs: lease.expiresAtUnixMs, binding: { ...grant.binding, capability: frame.capability },
            localSid: spec.executorSid, localSessionId: 0, peerSid: spec.controlSid, peerSessionId: 0,
            permitVirtualPeerQuery: true };
          bridge.send(policy); await bridge.expect('identity');
          const ready = await bridge.expect('ready');
          assert.equal(ready.protectedDacl, true); assert.equal(ready.rejectRemote, true); assert.equal(ready.firstInstance, true);
          await put(prefix + 'offer.json', { policy, frame, ready });
          const expected = await get(prefix + 'client.json');
          assert.equal(expected.sid, spec.controlSid); assert.equal(expected.sessionId, 0);
          bridge.send({ ...expected, ...(scenario === 'client-pin' ? { createdTicks: '1' } : {}) });
          const event = await bridge.next();
          if (success) {
            assert.equal(event.kind, 'request'); assert.equal(event.facts.queryOnlyAuthorityVerified, true);
            current.peer = event.facts; current.dacl = ready.dacl;
            const outcome = await grant.accept(event.frame, async binding => {
              current.dispatched++;
              const sums = {};
              for (const row of (await readFile(join(root, 'workspace/input.csv'), 'utf8')).trim().split(/\r?\n/).slice(1)) {
                const [name, amount] = row.split(','); sums[name] = (sums[name] || 0) + Number(amount);
              }
              return { ...binding, stopped: true, completed: true, text: JSON.stringify(sums) };
            });
            await assert.rejects(grant.accept(event.frame, async () => { current.dispatched++; }), { code: 'RESTRICTED_IPC_ALREADY_USED' });
            current.replayRefused = true;
            bridge.send(outcome); assert.equal((await bridge.exit).code, 0); assert.equal(current.dispatched, 1);
          } else {
            assert.equal(event.kind, 'error'); refusal(event.code, role, scenario);
            current.code = event.code; assert.equal(current.dispatched, 0);
          }
        } else {
          const { policy, frame, ready } = await get(prefix + 'offer.json');
          assert.equal(ready.facts.sid, spec.executorSid); assert.equal(ready.facts.sessionId, 0);
          const outgoing = { ...frame,
            ...(scenario === 'capability' ? { capability: 'z'.repeat(43) } : {}),
            ...(scenario === 'cross-run' ? { runId: 'run_different_12345678' } : {}) };
          const binding = { ...policy.binding,
            ...(scenario === 'capability' ? { capability: outgoing.capability } : {}),
            ...(scenario === 'cross-run' ? { runId: outgoing.runId } : {}) };
          bridge.send({ ...policy, binding, localSid: spec.controlSid, peerSid: spec.executorSid,
            peer: { ...ready.facts, ...(scenario === 'server-pin' ? { createdTicks: '1' } : {}) } });
          const identity = await bridge.expect('identity');
          await put(prefix + 'client.json', identity.facts);
          bridge.send(outgoing);
          const event = await bridge.next();
          if (success) {
            assert.equal(event.kind, 'result'); assert.equal(event.facts.queryOnlyAuthorityVerified, true);
            assert.deepEqual(JSON.parse(event.outcome.text), { alpha: 42, beta: 11 });
            assert.equal(event.outcome.stopped, true); assert.equal(event.outcome.completed, true);
            assert.equal((await bridge.exit).code, 0); current.peer = event.facts;
          } else { assert.equal(event.kind, 'error'); refusal(event.code, role, scenario); current.code = event.code; }
        }
        current.pass = true;
        await put(prefix + 'done.json', { pass: true, scenario });
        const done = await get(prefix + 'done.json'); assert.equal(done.pass, true); assert.equal(done.scenario, scenario);
      } finally { await bridge.close(); }
    }
    report.pass = report.cases.length === scenarios.length && report.cases.every(item => item.pass);
  } catch (error) { report.error = error.code || error.message; }
  return report;
}

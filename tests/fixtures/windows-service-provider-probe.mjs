// Cross-service candidate only. The original Run authority remains in the
// ordinary test coordinator; no production credentials/registry are adopted.
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, unlink, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createRestrictedRunIpcReceiver } from '../../chat/restricted-run-ipc.mjs';
import { endpoint } from '../helpers/windows-run-pipe-fixture.mjs';
import { serviceProviderWorker } from './windows-service-provider-worker.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
export async function serviceProviderProbe(root, role, spec) {
  const round = spec.ipcRound, prefix = `r${round}-provider-`;
  const mine = join(root, 'handoff', role), peer = join(root, 'handoff', role === 'control' ? 'executor' : 'control');
  const report = { pass: false, role, round, providerUsed: false, transportVerified: false };
  let bridge;
  async function put(dir, name, value) {
    await writeFile(join(dir, name + '.tmp'), JSON.stringify(value), { flag: 'wx' });
    await rename(join(dir, name + '.tmp'), join(dir, name));
  }
  async function get(dir, name, limit = 100000) {
    const until = Date.now() + limit;
    while (Date.now() < until) {
      try {
        const path = join(dir, name), facts = await lstat(path);
        assert.ok(facts.isFile() && !facts.isSymbolicLink() && facts.nlink === 1 && facts.size <= 131072);
        return JSON.parse(await readFile(path, 'utf8'));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(done => setTimeout(done, 25));
    }
    throw Object.assign(new Error('Service QA handoff deadline'), { code: 'SERVICE_HANDOFF_DEADLINE' });
  }
  function validate(request) {
    const receiver = createRestrictedRunIpcReceiver(request.policy);
    assert.equal(request.frame.payload.text, request.policy.text);
    assert.equal(request.providerSnapshotHash, hash(JSON.stringify(request.provider)));
    assert.equal(request.provider.protocol, 'anthropic-messages');
    assert.ok(typeof request.provider.profileRevision === 'string' && request.provider.profileRevision);
    assert.ok(typeof request.provider.authRevision === 'string' && request.provider.authRevision);
    assert.ok(typeof request.inputCSV === 'string' && request.inputCSV.length < 8192 && request.policy.text.includes(request.inputCSV));
    const url = new URL(request.provider.baseUrl);
    assert.equal(url.protocol, 'https:'); assert.ok(!url.username && !url.password && !url.search && !url.hash);
    return receiver;
  }
  async function claimRun(request) {
    const path = join(root, 'state/executor', 'claim-' + request.policy.runId + '.json');
    const handle = await open(path, 'wx');
    try { await handle.writeFile(JSON.stringify({ ...request.policy, capability: undefined, text: undefined, providerSnapshotHash: request.providerSnapshotHash, state: 'consumed' })); await handle.sync(); }
    finally { await handle.close(); }
  }
  try {
    assert.ok([1, 2].includes(round));
    if (role === 'executor') {
      const preflight = await serviceProviderWorker(root, spec, null, { boundaryOnly: true });
      report.preflight = preflight;
      await put(mine, prefix + 'preflight.json', { pass: preflight.pass, stopped: preflight.stopped });
      assert.equal(preflight.pass, true);
      const request = await get(peer, prefix + 'policy.json');
      const receiver = validate(request), binding = receiver.binding;
      const nativePolicy = { pipeName: 'ragent-run-candidate-' + randomBytes(16).toString('hex'),
        expiresAtUnixMs: binding.expiresAtUnixMs, binding: { ...binding, capability: request.policy.capability },
        localSid: spec.executorSid, localSessionId: 0, peerSid: spec.controlSid, peerSessionId: 0, permitVirtualPeerQuery: true };
      bridge = endpoint(join(root, 'runtime/RunPipeCandidate.exe'), 'server', { timeoutMs: 110000 });
      bridge.send(nativePolicy); await bridge.expect('identity'); const ready = await bridge.expect('ready');
      assert.equal(ready.protectedDacl, true); assert.equal(ready.rejectRemote, true); assert.equal(ready.firstInstance, true);
      report.pipeDacl = ready.dacl;
      await put(mine, prefix + 'ready.json', { nativePolicy, ready, providerSnapshotHash: request.providerSnapshotHash });
      bridge.send(await get(peer, prefix + 'client.json', 10000));
      const event = await bridge.expect('request');
      assert.equal(event.facts.queryOnlyAuthorityVerified, true); report.peer = event.facts; report.transportVerified = true;
      let calls = 0;
      const outcome = await receiver.accept(event.frame, async fields => {
        await claimRun(request); calls++;
        report.worker = await serviceProviderWorker(root, spec, request);
        report.providerUsed = report.worker.modelInvocations === 1;
        return { ...fields, stopped: report.worker.stopped === true, completed: report.worker.pass,
          ...(report.worker.output ? { text: JSON.stringify(report.worker.output) } : {}) };
      });
      await assert.rejects(receiver.accept(event.frame, () => { calls++; }), { code: 'RESTRICTED_IPC_ALREADY_USED' });
      const cold = createRestrictedRunIpcReceiver(request.policy);
      await assert.rejects(cold.accept(event.frame, async () => { await claimRun(request); calls++; }), { code: 'EEXIST' });
      assert.equal(calls, 1); report.calls = calls; report.replayRefused = true; report.coldReplayRefused = true;
      report.providerSnapshotHash = request.providerSnapshotHash;
      assert.equal(report.worker.native.runId, binding.runId);
      assert.equal(report.worker.native.authorityHash, binding.authorityHash);
      bridge.send(outcome); assert.equal((await bridge.exit).code, 0);
      report.pass = report.worker.pass;
      await put(mine, prefix + 'done.json', { pass: report.pass, worker: report.worker, providerSnapshotHash: request.providerSnapshotHash });
      await get(peer, prefix + 'done.json', 10000);
    } else {
      const outbox = join(root, 'control/outbox'), inbox = join(root, 'control/inbox');
      const preflight = await get(peer, prefix + 'preflight.json', 30000);
      await put(outbox, prefix + 'ready.json', { pass: preflight.pass });
      assert.equal(preflight.pass, true);
      const request = await get(inbox, prefix + 'request.json'); validate(request);
      await unlink(join(inbox, prefix + 'request.json'));
      await put(mine, prefix + 'policy.json', request);
      const { nativePolicy, ready, providerSnapshotHash } = await get(peer, prefix + 'ready.json', 10000);
      assert.equal(providerSnapshotHash, request.providerSnapshotHash);
      assert.equal(ready.facts.sid, spec.executorSid); assert.equal(ready.facts.sessionId, 0);
      await unlink(join(mine, prefix + 'policy.json')); report.secretHandoffRemoved = true;
      bridge = endpoint(join(root, 'runtime/RunPipeCandidate.exe'), 'client', { timeoutMs: 110000 });
      bridge.send({ ...nativePolicy, localSid: spec.controlSid, peerSid: spec.executorSid, peer: ready.facts });
      const own = await bridge.expect('identity'); await put(mine, prefix + 'client.json', own.facts);
      bridge.send(request.frame); const event = await bridge.expect('result');
      assert.equal(event.facts.queryOnlyAuthorityVerified, true); report.peer = event.facts; report.transportVerified = true;
      assert.equal((await bridge.exit).code, 0);
      const done = await get(peer, prefix + 'done.json', 10000);
      assert.equal(done.providerSnapshotHash, request.providerSnapshotHash);
      assert.equal(done.worker.native.runId, request.policy.runId);
      assert.equal(done.worker.native.grantId, request.policy.grantId);
      assert.equal(done.worker.native.requestId, request.policy.requestId);
      assert.equal(done.worker.native.authorityHash, request.policy.authorityHash);
      assert.equal(done.worker.native.providerSnapshotHash, request.providerSnapshotHash);
      assert.equal(done.worker.credentialsRemoved, true); assert.equal(done.worker.runtimeRemoved, true);
      assert.equal(done.worker.retainedSecretScan.remainingMatches, 0);
      report.providerUsed = done.worker.modelInvocations === 1; report.pass = done.pass;
      report.providerSnapshotHash = request.providerSnapshotHash;
      await put(outbox, prefix + 'result.json', { pass: done.pass, outcome: event.outcome,
        providerSnapshotHash, worker: done.worker, peer: event.facts });
      await put(mine, prefix + 'done.json', { pass: done.pass });
    }
  } catch (error) {
    report.error = error.code || error.name;
    if (role === 'control') await put(join(root, 'control/outbox'), prefix + 'failure.json', { pass: false, error: report.error }).catch(() => {});
  } finally { if (bridge) await bridge.close(); }
  return report;
}

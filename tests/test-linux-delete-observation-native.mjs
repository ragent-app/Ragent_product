import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { inspectAndAttestLinuxTarget } from '../scripts/linux-target-inspection.mjs';
import { loadOrCreateLinuxTargetKey } from '../chat/linux-target-key-store.mjs';
import { bindLinuxDeleteObservation } from '../chat/linux-delete-observation.mjs';
import { buildSemanticCapabilitySelection } from '../chat/semantic-capability.mjs';

if (process.platform !== 'linux' || process.geteuid?.() !== 0 || !process.argv[2]) throw new Error('requires Linux root and native helper');
const sourceStat = await lstat(process.argv[2]);
if (sourceStat.uid === 0) throw new Error('fixture helper must identify the unprivileged test user');
const root = await mkdtemp('/srv/ragent-delete-observation-');
await chmod(root, 0o755);
try {
  const helper = `${root}/helper`, target = `${root}/target`;
  const testHome = `${root}/test-home`;
  await mkdir(testHome, { mode: 0o700 });
  await chown(testHome, sourceStat.uid, sourceStat.gid);
  await copyFile(process.argv[2], helper);
  await chown(helper, 0, 0);
  await chmod(helper, 0o755);
  await writeFile(target, 'fixture', { mode: 0o600 });
  const digest = createHash('sha256').update(await readFile(helper)).digest('hex');
  const keys = await loadOrCreateLinuxTargetKey(`${root}/keys`, { initialize: true });
  const request = { rawCommand: `rm ${target}`, sessionId: 's1', runId: 'r1', turnId: 't1', requestKey: 'q1', executionClass: 'host' };
  // Resolve as the ordinary test user; it can stat the root-owned file but
  // cannot read or mutate it. The root inspection is a separate process.
  const moduleUrl = new URL('../chat/semantic-approval.mjs', import.meta.url).href;
  const script = `import {prepareSemanticApproval} from ${JSON.stringify(moduleUrl)};
const request = JSON.parse(process.argv[1]), root = process.argv[2];
const result = await prepareSemanticApproval({ request, trustedContext: { cwd: root, projectRoot: root, home: process.env.HOME, platform: 'linux' } });
process.stdout.write(JSON.stringify(result.projection));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(request), root],
    { uid: sourceStat.uid, gid: sourceStat.gid, encoding: 'utf8', maxBuffer: 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', HOME: testHome, TMPDIR: testHome, AGENTOC_CONFIG_DIR: `${testHome}/config` } });
  assert.equal(child.status, 0, child.stderr);
  const projection = JSON.parse(child.stdout);
  assert.equal(projection.decision, 'ASK');
  assert.equal(projection.decisions.length, 1);
  const context = { sessionId: 's1', runId: 'r1', turnId: 't1', requestId: 'q1' };
  const attestation = await inspectAndAttestLinuxTarget({ helperPath: helper, expectedSha256: digest, privateKey: keys.privateKey, targetPath: target, context });
  const bound = bindLinuxDeleteObservation({ decision: projection.decisions[0], attestation, trustedPublicKey: keys.publicKey });
  assert.equal(bound.decision, 'ASK');
  assert.equal(bound.operation.target.resourceSnapshot.linuxTargetAttestation.binding.path, target);
  const selection = buildSemanticCapabilitySelection([bound]);
  assert.equal(selection.operations[0].adapterInput.linuxTargetAttestation.binding.path, target);
  assert.match(selection.selectionManifestHash, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(target, 'utf8'), 'fixture');
  console.log('linux delete observation: native and unprivileged resolver identities agree');
} finally {
  await rm(root, { recursive: true });
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, chown, copyFile, link, lstat, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { inspectAndAttestLinuxTarget } from '../scripts/linux-target-inspection.mjs';
import { loadLinuxTargetPublicKey, loadOrCreateLinuxTargetKey } from '../chat/linux-target-key-store.mjs';
import { verifyLinuxTargetAttestation } from '../chat/linux-target-attestation.mjs';

if (process.platform !== 'linux' || process.geteuid?.() !== 0 || !process.argv[2]) throw new Error('requires Linux root and native helper');
const root = await mkdtemp('/var/lib/ragent-target-inspection-');
await chmod(root, 0o700);
try {
  const helper = `${root}/helper`, target = `${root}/target`, keyDirectory = `${root}/keys`;
  await copyFile(process.argv[2], helper);
  await chown(helper, 0, 0);
  await chmod(helper, 0o755);
  const helperStat = await lstat(helper, { bigint: true });
  assert.ok(helperStat.isFile() && helperStat.uid === 0n && helperStat.gid === 0n && helperStat.nlink === 1n &&
    (helperStat.mode & 0o022n) === 0n && (helperStat.mode & 0o100n) !== 0n && helperStat.size >= 20n && helperStat.size <= 16777216n,
    `fixture helper uid=${helperStat.uid} gid=${helperStat.gid} mode=${helperStat.mode.toString(8)} links=${helperStat.nlink} size=${helperStat.size}`);
  await writeFile(target, 'fixture', { mode: 0o600 });
  const digest = createHash('sha256').update(await readFile(helper)).digest('hex');
  const keys = await loadOrCreateLinuxTargetKey(keyDirectory, { initialize: true });
  const context = { sessionId: 'test-session', runId: 'test-run', turnId: 'test-turn', requestId: 'test-request' };
  const input = { helperPath: helper, expectedSha256: digest, privateKey: keys.privateKey, targetPath: target, context };
  const attestation = await inspectAndAttestLinuxTarget(input);
  const trusted = await loadLinuxTargetPublicKey(keyDirectory);
  const checked = verifyLinuxTargetAttestation(attestation, { publicKey: trusted.publicKey, expectedContext: context, expectedPath: target });
  assert.equal(checked.ok, true);
  assert.equal(checked.binding.size, '7');
  assert.equal(await readFile(target, 'utf8'), 'fixture');
  await assert.rejects(inspectAndAttestLinuxTarget({ ...input, expectedSha256: '0'.repeat(64) }));
  await assert.rejects(inspectAndAttestLinuxTarget({ ...input, targetPath: '--remove' }));
  await assert.rejects(inspectAndAttestLinuxTarget({ ...input, context: { ...context, requestId: '' } }));
  await chmod(helper, 0o777);
  await assert.rejects(inspectAndAttestLinuxTarget(input));
  await chmod(helper, 0o755);
  await link(helper, `${root}/helper-link`);
  await assert.rejects(inspectAndAttestLinuxTarget(input));
  await unlink(`${root}/helper-link`);
  await rename(helper, `${root}/helper-real`);
  await symlink(`${root}/helper-real`, helper);
  await assert.rejects(inspectAndAttestLinuxTarget(input));
  await unlink(helper);
  await rename(`${root}/helper-real`, helper);
  await symlink(target, `${root}/target-link`);
  await assert.rejects(inspectAndAttestLinuxTarget({ ...input, targetPath: `${root}/target-link` }));
  await chmod(root, 0o777);
  await assert.rejects(inspectAndAttestLinuxTarget(input));
  await chmod(root, 0o700);
  assert.equal(await readFile(target, 'utf8'), 'fixture');
  console.log('linux target inspection: pinned helper and signed snapshot checks passed');
} finally {
  await chmod(root, 0o700);
  await rm(root, { recursive: true });
}

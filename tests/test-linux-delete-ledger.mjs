import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { claimLinuxDeleteNonce, recordLinuxDeletePhase } from '../scripts/linux-delete-ledger.mjs';

if (process.platform !== 'linux' || process.geteuid?.() !== 0) throw new Error('requires Linux root');
const root = await mkdtemp('/var/lib/ragent-delete-ledger-');
await chmod(root, 0o700);
const directory = `${root}/ledger`;
await mkdir(directory, { mode: 0o700 });
const input = { directory, nonce: 'A'.repeat(32), capabilityId: 'scap_test', runId: 'run_test', selectionHash: 'a'.repeat(64) };

function childClaim(value) {
  const moduleUrl = new URL('../scripts/linux-delete-ledger.mjs', import.meta.url).href;
  const script = `import {claimLinuxDeleteNonce} from ${JSON.stringify(moduleUrl)};
process.stdout.write(JSON.stringify(await claimLinuxDeleteNonce(JSON.parse(process.argv[1]))));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(value)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
}

try {
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => claimLinuxDeleteNonce(input)));
  assert.equal(concurrent.filter((entry) => entry.state === 'claimed').length, 1);
  assert.equal(concurrent.filter((entry) => entry.state === 'consumed').length, 11);
  const digest = createHash('sha256').update(input.nonce).digest('hex');
  const marker = `${directory}/${digest}.json`;
  assert.equal((await stat(marker)).mode & 0o777, 0o600);
  const record = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(record.nonceDigest, digest);
  assert.equal(Object.hasOwn(record, 'nonce'), false);
  assert.equal((await childClaim(input)).state, 'consumed');
  assert.equal((await recordLinuxDeletePhase({ ...input, phase: 'result', resultState: 'completed' })).state, 'unavailable');
  assert.equal((await recordLinuxDeletePhase({ ...input, capabilityId: 'other', phase: 'started' })).state, 'unavailable');
  const starts = await Promise.all(Array.from({ length: 4 }, () => recordLinuxDeletePhase({ ...input, phase: 'started' })));
  assert.equal(starts.filter((entry) => entry.state === 'recorded').length, 1);
  assert.equal(starts.filter((entry) => entry.state === 'already-recorded').length, 3);
  assert.equal((await recordLinuxDeletePhase({ ...input, phase: 'result', resultState: 'completed' })).state, 'recorded');
  assert.equal((await recordLinuxDeletePhase({ ...input, phase: 'result', resultState: 'completed' })).state, 'already-recorded');
  const resultRecord = JSON.parse(await readFile(`${directory}/${digest}.result.json`, 'utf8'));
  assert.equal(resultRecord.resultState, 'completed');
  assert.equal(Object.hasOwn(resultRecord, 'nonce'), false);

  const crossProcess = { ...input, nonce: 'B'.repeat(32) };
  const children = await Promise.all(Array.from({ length: 6 }, () => childClaim(crossProcess)));
  assert.equal(children.filter((entry) => entry.state === 'claimed').length, 1);
  assert.equal(children.filter((entry) => entry.state === 'consumed').length, 5);
  assert.equal((await childClaim(crossProcess)).state, 'consumed');

  const partial = { ...input, nonce: 'C'.repeat(32) };
  const partialMarker = `${directory}/${createHash('sha256').update(partial.nonce).digest('hex')}.json`;
  await writeFile(partialMarker, '{', { mode: 0o600 });
  assert.equal((await claimLinuxDeleteNonce(partial)).state, 'consumed');
  assert.equal((await childClaim(partial)).state, 'consumed');
  assert.equal((await recordLinuxDeletePhase({ ...partial, phase: 'started' })).state, 'unavailable');
  const invalid = { ...input, nonce: 'short' };
  assert.equal((await claimLinuxDeleteNonce(invalid)).state, 'unavailable');
  const fresh = { ...input, nonce: 'D'.repeat(32) };
  await chmod(directory, 0o777);
  assert.equal((await claimLinuxDeleteNonce(fresh)).state, 'unavailable');
  await chmod(directory, 0o700);
  assert.equal((await claimLinuxDeleteNonce(fresh)).state, 'claimed');
  await symlink(directory, `${root}/alias`);
  assert.equal((await claimLinuxDeleteNonce({ ...input, directory: `${root}/alias`, nonce: 'E'.repeat(32) })).state, 'unavailable');
  console.log('linux delete ledger: durable and concurrent claims passed');
} finally {
  await chmod(root, 0o700);
  await rm(root, { recursive: true });
}

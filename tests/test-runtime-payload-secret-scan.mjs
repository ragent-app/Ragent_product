import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRuntimePayload, secretKinds } from '../scripts/verify-runtime-payload.mjs';

const syntheticKey = `sk-proj-${'Z'.repeat(40)}`;
assert.ok(secretKinds(`token="${syntheticKey}"`).includes('provider-secret'));
assert.ok(!secretKinds(`vendor-prefix-${syntheticKey}`).includes('provider-secret'));

const root = await mkdtemp(join(tmpdir(), 'agentoc-secret-scan-'));
try {
  // The second stream window begins at the embedded sk- token. Preserve its
  // preceding hyphen so an internal identifier cannot become a standalone key.
  const embedded = `${'x'.repeat(32767)}-${syntheticKey}${'x'.repeat(65536)}`;
  await writeFile(join(root, 'vendor.bin'), embedded);
  assert.equal((await scanRuntimePayload(root)).ok, true);
  await writeFile(join(root, 'credential.txt'), `key=${syntheticKey}\n`);
  await writeFile(join(root, 'split.txt'), `${'x'.repeat(65529)} key=${syntheticKey}\n`);
  const result = await scanRuntimePayload(root);
  assert.ok(result.findings.some(({ path, kind }) => path === 'credential.txt' && kind === 'provider-secret'));
  assert.ok(result.findings.some(({ path, kind }) => path === 'split.txt' && kind === 'provider-secret'));
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('runtime payload secret boundary checks passed');
